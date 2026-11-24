"""
build_data.py
讀取上一層 110–114 資料夾的 .dta，計算加權彙總統計，輸出給網頁使用：
  data/survey_data.js    （window.SURVEY_DATA = {...}；網頁直接以 <script> 載入，file:// 可用）
  data/survey_data.json  （同內容，方便檢查）

估計方式：
  - 加權比例（110–113 年 wgat_t1，114 年 wgat_t2）。
  - 「正面比例」= 非常＋還算（代碼 1、2）；分母排除無意見／拒答（98）與跳答（99、空值）。
  - 95% 信賴區間以 Kish 有效樣本數計算；n 為未加權人數。
新增年度時：在 MAP 中加入該年題號對照即可。
"""
import json
import re
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "data"
YEARS = ["110", "111", "112", "113", "114"]
SMALL_N = 100
MIN_CELL = 10  # 細格未加權人數少於此值不發布（避免揭露個別受訪者作答）

# ---------------------------------------------------------------- 題號對照
_old = dict(age="q1", county="q2", indep="q6_1", lawful="q6_2", sent="q6_3", willing="q8",
            visit="q9", sued="q11", hasj="q12", accept="q12_2", hearing="q13",
            p_attitude="q14_1", p_voice="q14_2", p_punctual="q14_3", p_pace="q14_4", cred="q14_5",
            change="q16", overall="q17", edu="q18", sex="q20", lang="q21", w="wgat_t1",
            media="q5_", reasons="q8_1_", service="q15_")
_new = dict(age="age", county="county", indep="q5_1", lawful="q5_2", sent="q5_3", willing="q7",
            visit="q8", sued="q10", hasj="q11", accept="q11_2", hearing="q12",
            p_attitude="q13_1", p_voice="q13_2", p_punctual="q13_3", p_pace="q13_4", cred="q13_5",
            change="q15", overall="q16", edu="edu", sex="gender", lang="q23", w="wgat_t1",
            media="q4_", reasons="q7_1_", service="q14_")
MAP = {
    "110": {**_old, "trust": "q7_1", "know": ["q4_1", "q4_2", "q4_6", "q4_7"], "know_key": [2, 2, 2, 2]},
    "111": {**_old, "trust": "q7", "know": ["q4_1", "q4_2", "q4_6", "q4_7"], "know_key": [2, 2, 2, 1]},
    "112": {**_new, "trust": "q6", "know": ["q17_1", "q17_2", "q17_6", "q17_7"], "know_key": [2, 2, 2, 1]},
    "113": {**_new, "trust": "q6_1", "indep": "q5_3", "lawful": "q5_1", "sent": "q5_2", "lang": None,
            "know": ["q17_1", "q17_2", "q17_5", "q17_6"], "know_key": [2, 2, 2, 1]},
    "114": {**_new, "trust": "q6_1", "w": "wgat_t2",
            "know": ["q17_1", "q17_2", "q17_4", "q17_6"], "know_key": [2, 2, 2, 1]},
}

# ---------------------------------------------------------------- 指標定義
LIKERT = {
    "trust": ["非常信任", "還算信任", "不太信任", "完全不信任"],
    "agree": ["非常同意", "還算同意", "不太同意", "完全不同意"],
    "will": ["非常願意", "還算願意", "不太願意", "完全不願意"],
    "sat": ["非常滿意", "還算滿意", "不太滿意", "非常不滿意"],
}
INDICATORS = {
    "trust":   dict(label="信任法官", scale="trust", base="全體受訪者",
                    question="整體來說，您信任「法官」嗎？"),
    "lawful":  dict(label="法官能依法判決", scale="agree", base="全體受訪者",
                    question="您同不同意目前「我國大部分的法官都能依法判決」？"),
    "sent":    dict(label="法官能適當量刑", scale="agree", base="全體受訪者",
                    question="您同不同意目前「我國大部分的法官都能盡力對罪犯作適當的判刑」？"),
    "indep":   dict(label="法官能獨立審判", scale="agree", base="全體受訪者",
                    question="您同不同意目前「我國大部分的法官都能獨立審判」？",
                    note="112、113、114 年各修改一次題目措辭（113、114 年加入憲法說明），跨年比較須保留。",
                    wording_change=[112, 113, 114]),
    "willing": dict(label="願意上法院解決糾紛", scale="will", base="全體受訪者",
                    question="當您與人發生糾紛時，您願不願意上法院解決糾紛？"),
    "overall": dict(label="到法院整體經驗滿意", scale="sat", base="曾到過法院者",
                    question="就您到法院的整體經驗而言，您覺得滿不滿意？"),
}
BREAKDOWN_KEYS = ["trust", "lawful", "sent", "indep", "willing"]

HEARING_ITEMS = {
    "p_attitude": "法官問案態度",
    "p_voice": "法官給予陳述或答辯的時間",
    "p_punctual": "法官開庭準時",
    "p_pace": "法官審理案件的進度",
    "cred": "法官審判的公信力",
}
SERVICE_RULES = [  # (關鍵字, 統一名稱) — 依題目標籤對齊，因為各年題號不同
    ("諮詢", "訴訟程序諮詢服務"), ("單一窗口", "單一窗口服務便利性"), ("志工", "志工服務"),
    ("性別", "職員性別平等意識"), ("服務態度", "職員服務態度"), ("業務熟悉", "職員業務熟悉度"),
    ("指示牌", "指示牌標示清楚"), ("網站", "網站便民查詢服務"), ("範例", "書狀範例實用性"),
]
MEDIA_CODES = {100: "電視", 200: "廣播", 300: "報紙", 400: "雜誌", 500: "書刊",
               601: "網路新聞", 602: "社群網站（FB、IG 等）", 603: "通訊軟體（LINE 等）",
               604: "法律相關網站", 605: "影音平台（YouTube 等）", 700: "學校或大學課程",
               800: "家人朋友轉告", 900: "個人親身經驗"}
KNOW_ITEMS = [
    "「偵查犯罪及提起公訴是法官的工作」→ 錯誤",
    "「少年及家事法庭任何人都可旁聽」→ 錯誤",
    "「民事強制執行毋需考量債務人權益」→ 錯誤",
    "營業秘密案件可聲請不公開審判 → 正確",
]
DIMS = {
    "age": dict(label="年齡", cats=["29歲以下", "30–39歲", "40–49歲", "50–59歲", "60歲以上"],
                note="110、111 年最低年齡為 20 歲，112 年起為 18 歲。"),
    "edu": dict(label="教育程度", cats=["國中以下", "高中職", "專科", "大學", "研究所以上"]),
    "sex": dict(label="性別", cats=["男性", "女性"]),
    "lang": dict(label="訪問使用語言", cats=["國語", "台語", "客語"], note="113 年未記錄訪問語言。"),
}
NOTES = [
    "「法官能獨立審判」題 112、113、114 年各修改一次措辭，跨年變化可能部分來自題目改變。",
    "114 年開庭經驗題改為「是否有參與由法官主持的開庭」，回答有開庭經驗者減少。",
    "110、111 年訪問對象為 20 歲以上，112 年起為 18 歲以上。",
    "「普通」選項未由訪員主動唸出，選答者僅 2–4%，本網頁的正面比例以「非常＋還算」計算。",
    "正面比例的分母排除「無意見／拒答」，因此會比官方報告（分母含無意見）高 1–3 個百分點；分布圖則保留無意見類別，可與報告直接對照。",
    "110、113 年分布已與官方報告核對一致；114 年以公開資料檔權重（wgat_t2）計算，與報告約有 1 個百分點差異（例如信任法官 60.8% vs. 報告 59.8%）。",
    "「不願上法院原因」由訪員逐一唸出選項詢問，每人平均勾選 4–5 項，因此各原因比例普遍偏高。",
    "縣市、族群細格樣本較小（多數縣市每年少於 100 人時會標示），信賴區間較寬，請勿過度解讀。",
    "112 年起「不願上法院原因」新增「不信任司法」「尋求社會人士協助即可」等選項，與前兩年不可直接比較。",
]


# ---------------------------------------------------------------- 工具函式
def clean_label(s: str) -> str:
    s = re.sub(r"【[^】]*(】|$)", "", str(s))
    s = re.sub(r"[@#]+", "", s)
    return s.strip()


def wprop(mask_pos, mask_valid, w):
    """加權比例與 95% CI（Kish 有效樣本數）。mask_valid 為分母。"""
    v = mask_valid.values if hasattr(mask_valid, "values") else mask_valid
    if v.sum() == 0:
        return None
    ww = w[v]
    p = float(np.sum(ww * mask_pos[v]) / np.sum(ww))
    neff = ww.sum() ** 2 / np.sum(ww ** 2)
    se = np.sqrt(p * (1 - p) / neff)
    return dict(p=round(p * 100, 2), lo=round(max(0, p - 1.96 * se) * 100, 2),
                hi=round(min(1, p + 1.96 * se) * 100, 2), n=int(v.sum()))


def likert_stats(s, w, base=None):
    s = s.astype(float)
    base = np.ones(len(s), bool) if base is None else base
    valid = base & s.between(1, 5).values
    out = wprop((s.isin([1, 2])).values, valid, w)
    if out is None:
        return None
    # 分布：1,2,4,5 + 普通(3) + 無意見(98)，分母含無意見
    inc = base & (s.between(1, 5) | (s == 98)).values
    tot = w[inc].sum()
    dist = {str(int(c)): round(float(w[inc & (s == c).values].sum() / tot * 100), 2) for c in (1, 2, 3, 4, 5, 98)}
    out["dist"] = dist
    out["mean"] = round(float(np.average(6 - s[valid], weights=w[valid])), 3)
    return out


def recode_dims(df, m):
    age = df[m["age"]].astype(float)
    edu = df[m["edu"]].astype(float)
    edu5 = pd.cut(edu, [0, 3, 4, 5, 6, 7], labels=False)  # 0..4
    sex = df[m["sex"]].astype(float)
    lang = df[m["lang"]].astype(float) if m["lang"] else pd.Series(np.nan, index=df.index)
    return {
        "age": np.where(age.between(1, 5), age - 1, np.nan),
        "edu": np.where(edu.between(1, 7), edu5, np.nan),
        "sex": np.where(sex.isin([1, 2]), sex - 1, np.nan),
        "lang": np.where(lang.between(1, 3), lang - 1, np.nan),
    }


# ---------------------------------------------------------------- 主程式
def main():
    R = dict(trend={k: {} for k in INDICATORS}, breakdown={k: {d: {} for d in DIMS} for k in BREAKDOWN_KEYS},
             county={k: {} for k in BREAKDOWN_KEYS}, funnel={}, hearing={k: {} for k in HEARING_ITEMS},
             service={}, change={}, reasons={}, media={v: {} for v in MEDIA_CODES.values()},
             knowledge={i: {} for i in range(len(KNOW_ITEMS))}, sample={})
    county_names = {}

    for y in YEARS:
        m = MAP[y]
        rd = pd.io.stata.StataReader(ROOT / y / f"data{y}.dta")
        df = rd.read(convert_categoricals=False)
        vlab, varlab = rd.value_labels(), rd.variable_labels()
        lbl_of = dict(zip(df.columns, rd._lbllist))
        Y = int(y)
        w = df[m["w"]].astype(float).values
        n_all = len(df)
        R["sample"][Y] = dict(n=n_all, weight=m["w"])
        allmask = np.ones(n_all, bool)
        visited = (df[m["visit"]] == 1).values

        # 1. 趨勢指標
        for k in INDICATORS:
            base = visited if k == "overall" else None
            R["trend"][k][Y] = likert_stats(df[m[k]], w, base)

        # 2. 族群與縣市
        dims = recode_dims(df, m)
        cty = df[m["county"]].astype(float).values
        for code, name in vlab.get(lbl_of[m["county"]], {}).items():
            if 1 <= int(code) <= 21:
                county_names[int(code)] = clean_label(name)
        for k in BREAKDOWN_KEYS:
            s = df[m[k]].astype(float)
            for d, codes in dims.items():
                rows = []
                for i, cat in enumerate(DIMS[d]["cats"]):
                    st = likert_stats(s, w, base=(codes == i))
                    st = st if st and st["n"] >= MIN_CELL else None
                    rows.append(dict(cat=cat, **{kk: vv for kk, vv in st.items() if kk != "dist"}) if st else None)
                R["breakdown"][k][d][Y] = rows if any(rows) else None
            rows = []
            for c in range(1, 22):
                st = likert_stats(s, w, base=(cty == c))
                if st and st["n"] >= MIN_CELL:
                    rows.append(dict(code=c, p=st["p"], lo=st["lo"], hi=st["hi"], n=st["n"], mean=st["mean"]))
            R["county"][k][Y] = rows

        # 3. 法院使用經驗漏斗（占全體的加權比例）
        litig = df[m["sued"]].isin([1, 3]).values
        hear = litig & (df[m["hearing"]] == 1).values
        judged = litig & (df[m["hasj"]] == 1).values
        acc = judged & (df[m["accept"]] == 1).values
        R["funnel"][Y] = {lab: wprop(mk, allmask, w) for lab, mk in
                          [("到過法院", visited), ("打過官司", litig), ("有開庭經驗", hear),
                           ("已有判決", judged), ("接受判決結果", acc)]}
        R["funnel"][Y]["接受判決（占已判決者）"] = wprop(acc, judged, w)

        # 4. 開庭滿意度（打過官司且有開庭經驗者）
        for k in HEARING_ITEMS:
            s = df[m[k]].astype(float)
            R["hearing"][k][Y] = wprop(s.isin([1, 2]).values, hear & s.between(1, 5).values, w)

        # 5. 法院服務滿意度（依題目標籤對齊；排除未接觸／沒用過）
        svc_cols = [c for c in df.columns if c.startswith(m["service"]) and c.count("_") == 1]
        for c in svc_cols:
            lab = varlab.get(c, "")
            name = next((nm for kw, nm in SERVICE_RULES if kw in lab), None)
            if not name:
                continue
            s = df[c].astype(float)
            R["service"].setdefault(name, {})[Y] = wprop(s.isin([1, 2]).values, s.between(1, 5).values, w)

        # 6. 去過法院後觀感變化（曾到過法院者）
        ch = df[m["change"]].astype(float).values
        okc = visited & np.isin(ch, [1, 2, 3])
        R["change"][Y] = {lab: wprop(ch == c, okc, w) for c, lab in [(2, "更好"), (1, "相同／與預期相符"), (3, "更差")]}

        # 7. 不願上法院的原因（回答不太／完全不願意者；複選，依標籤對齊）
        rcols = [c for c in df.columns if c.startswith(m["reasons"])]
        unwilling = df[m["willing"]].isin([4, 5]).values
        labels = {int(k): clean_label(v) for k, v in vlab.get(lbl_of[rcols[0]], {}).items()
                  if int(k) not in (98, 99)}
        rv = df[rcols]
        res = []
        for code, lab in labels.items():
            st = wprop((rv == code).any(axis=1).values, unwilling, w)
            res.append(dict(label=lab, **st))
        R["reasons"][Y] = sorted(res, key=lambda r: -r["p"])

        # 8. 資訊管道（全體；複選）
        mcols = [c for c in df.columns if c.startswith(m["media"]) and c.count("_") == 1]
        mv = df[mcols]
        offered = set(int(k) for k in vlab.get(lbl_of[mcols[0]], {}).keys())
        for code, lab in MEDIA_CODES.items():
            R["media"][lab][Y] = wprop((mv == code).any(axis=1).values, allmask, w) if code in offered else None

        # 9. 法律常識（全體；答對率與「不清楚」比例）
        for i, (c, key) in enumerate(zip(m["know"], m["know_key"])):
            s = df[c].astype(float)
            ok = s.isin([1, 2, 3]).values
            st = wprop((s == key).values, ok, w)
            st["unsure"] = wprop((s == 3).values, ok, w)["p"]
            R["knowledge"][i][Y] = st

    R["countyNames"] = {str(k): v for k, v in sorted(county_names.items())}
    R["meta"] = dict(
        title="一般民眾對司法認知調查 110–114 年", years=[int(y) for y in YEARS],
        generated=str(date.today()), smallN=SMALL_N, indicators=INDICATORS, likert=LIKERT,
        breakdownKeys=BREAKDOWN_KEYS, dims=DIMS, hearingItems=HEARING_ITEMS, knowItems=KNOW_ITEMS,
        notes=NOTES,
        method="電話調查（市話與手機雙底冊），每年約 5,000 位受訪者。百分比為加權估計，"
               "區間為 95% 信賴區間（以 Kish 有效樣本數計算）。",
    )
    OUT.mkdir(exist_ok=True)
    txt = json.dumps(R, ensure_ascii=False, separators=(",", ":"))
    (OUT / "survey_data.json").write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "survey_data.js").write_text("window.SURVEY_DATA = " + txt + ";\n", encoding="utf-8")
    print("written:", OUT / "survey_data.js", f"{len(txt)/1024:.0f} KB")


if __name__ == "__main__":
    main()
