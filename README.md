# Japan Weekly Portfolio Investment Flows (MOF)

Weekly **cross-border securities flows of Japan** from the Ministry of Finance (財務省「対外及び対内証券売買契約等の状況（週次・指定報告機関ベース）」) as clean JSON — the earliest official signal of how Japanese investors are moving money abroad and how foreign investors are buying or selling Japanese stocks and bonds.

- **Outward** (residents' transactions in foreign securities — Portfolio Investment Assets) and **inward** (non-residents' transactions in Japanese securities — Portfolio Investment Liabilities)
- By asset class: **equity & investment fund shares**, **long-term debt**, **short-term debt** — acquisitions, dispositions and net, plus subtotal and total
- Weekly since January 2005, published weekly (usually Thursday, Japan time; see the MOF release schedule), ahead of the monthly balance-of-payments statistics
- **Monitoring mode** reports new weeks and **revisions** of already published weeks

## Use cases

- **Markets & research:** track foreign investors' net buying of Japanese equities and JGBs week by week; yen and bond-flow analysis
- **Dashboards & newsletters:** a weekly feed for macro dashboards and market commentary
- **AI agents:** answer "did foreigners buy or sell Japanese stocks last week, and how much?"

## Input examples

Last 8 weeks (default):

```json
{ "latestWeeks": 8 }
```

Full history in long format for a BI tool:

```json
{ "from": "2005-01-01", "format": "long" }
```

Weekly monitoring with revision detection (schedule after the weekly release — usually Thursday, Japan time; check the [MOF release schedule](https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/schedule.htm) for holiday shifts):

```json
{ "onlyNew": true, "latestWeeks": 12, "stateKey": "weekly" }
```

## Output example (wide)

```json
{
  "weekStart": "2026-11-08",
  "weekEnd": "2026-11-14",
  "outward": {
    "equityAcquisition": 29395, "equityDisposition": 25764, "equityNet": 3631,
    "longTermDebtAcquisition": 80223, "longTermDebtDisposition": 84630, "longTermDebtNet": -4407,
    "subtotalNet": -776,
    "shortTermDebtAcquisition": 8458, "shortTermDebtDisposition": 6550, "shortTermDebtNet": 1908,
    "totalNet": 1132
  },
  "inward": {
    "equityAcquisition": 413220, "equityDisposition": 415461, "equityNet": -2241,
    "longTermDebtAcquisition": 60244, "longTermDebtDisposition": 53743, "longTermDebtNet": 6501,
    "subtotalNet": 4260,
    "shortTermDebtAcquisition": 48118, "shortTermDebtDisposition": 46500, "shortTermDebtNet": 1618,
    "totalNet": 5878
  },
  "unit": "100 million JPY",
  "lastUpdated": "令和8年11月19日",
  "sourceUrl": "https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/week.csv",
  "source": "Ministry of Finance, Japan — International Transactions in Securities (weekly, designated major investors)"
}
```

- Values are in **100 million yen** as published. **Net = acquisition − disposition**: a plus sign means net acquisition (buying), minus means net disposition (selling).
- Figures are based on reports from designated major investors; totals may not add up exactly due to rounding (as noted by MOF). From January 2014 investment-fund transactions are recorded under "equity and investment fund shares".
- In monitoring mode, `changeType` is `new` or `revision`. Rows carry a stable `eventId` (week + published values) for de-duplication downstream. Corrections that change only a week's dates are not detected. Only the weeks inside the selected range (`latestWeeks` or `from`/`to`) are compared, so choose a range that covers the revisions you care about (e.g. the last 12 weeks).
- `equityIncludesInvestmentFunds` is `true` from January 2014, when MOF moved investment-fund transactions (including open-end contractual funds previously under long-term debt) into "equity and investment fund shares". Take this into account when comparing across 2014.

## How it works

One request per run for the official weekly CSV (CP932), parsed and validated (column layout, 23 columns per week, week dates). If MOF changes the layout, the run fails with a clear message instead of returning wrong numbers.

## Data source & terms

Source: Ministry of Finance, Japan (財務省). Content available under the Public Data License 1.0 ([MOF terms of use](https://www.mof.go.jp/about_mof/notice/index.html)). When you publish the data, credit the source and state that it was processed and by whom, for example:

> 出典：財務省「対外及び対内証券売買契約等の状況（週次・指定報告機関ベース）」（https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/data.htm）を〇〇が加工して作成（Japan Weekly Portfolio Investment Flows (MOF) Actor で CSV を JSON に変換・項目名を英語化）
 This Actor is not affiliated with or endorsed by the Ministry of Finance.

---

## 日本語の概要

財務省「対外及び対内証券売買契約等の状況（週次・指定報告機関ベース）」の CSV を取得し、居住者の対外証券投資と非居住者の対内証券投資（株式・投資ファンド持分、中長期債、短期債の取得・処分・ネット）を週ごとに JSON で返します。監視モードでは新しい週と、公表済みの週の改訂だけを出力します。単位は億円。出典の明記など公共データ利用規約（第1.0版）に従ってご利用ください。
