/**
 * ISO 4217 active currency list, plus the legacy codes Splitwise still accepts.
 *
 * WHY THIS IS COMPLETE RATHER THAN "the ones we need": `expenses.currency_code`
 * is a foreign key into this table, so a missing currency does not degrade
 * gracefully — it rejects the expense outright. A partial list is a latent bug
 * that surfaces the first time someone travels somewhere unexpected.
 *
 * It also has to cover DEMONETISED currencies. Splitwise's live list (captured
 * at fixtures/splitwise/get_currencies.json) includes HRK, LTL, VEF and others
 * that no longer exist, because their users have historical expenses in them.
 * Dropping those codes would make importing that history impossible — see
 * LEGACY_CODES at the bottom of this file.
 *
 * `decimals` is the ISO 4217 minor-unit exponent and is LOAD-BEARING: it is the
 * only way to turn a minor-unit integer back into a display string. Getting it
 * wrong multiplies or divides someone's money by 100.
 *
 *   0 decimals — JPY, KRW, VND, ISK, and the African franc zones
 *   3 decimals — Gulf dinars (BHD, KWD, OMR, IQD, JOD, LYD) and TND
 *   4 decimals — CLF, UYW (accounting units, included for completeness)
 *   2 decimals — everything else
 *
 * Note on MGA/MRU: ISO 4217 assigns these exponent 2 (subdivisions of 1/5),
 * though they are quoted without decimals in practice and some payment
 * processors treat them as zero-decimal. We follow ISO.
 *
 * Symbols are provided for commonly used currencies only; null elsewhere is
 * fine, the frontend falls back to the code.
 */

export interface CurrencyDefinition {
  code: string;
  decimals: number;
  symbol: string | null;
  name: string;
}

/** [code, decimals, symbol, name] */
const RAW: Array<[string, number, string | null, string]> = [
  ["AED", 2, "د.إ", "UAE Dirham"],
  ["AFN", 2, "؋", "Afghan Afghani"],
  ["ALL", 2, "L", "Albanian Lek"],
  ["AMD", 2, "֏", "Armenian Dram"],
  ["ANG", 2, "ƒ", "Netherlands Antillean Guilder"],
  ["AOA", 2, "Kz", "Angolan Kwanza"],
  ["ARS", 2, "$", "Argentine Peso"],
  ["AUD", 2, "A$", "Australian Dollar"],
  ["AWG", 2, "ƒ", "Aruban Florin"],
  ["AZN", 2, "₼", "Azerbaijani Manat"],
  ["BAM", 2, "KM", "Bosnia-Herzegovina Convertible Mark"],
  ["BBD", 2, "$", "Barbadian Dollar"],
  ["BDT", 2, "৳", "Bangladeshi Taka"],
  ["BGN", 2, "лв", "Bulgarian Lev"],
  ["BHD", 3, "د.ب", "Bahraini Dinar"],
  ["BIF", 0, "FBu", "Burundian Franc"],
  ["BMD", 2, "$", "Bermudian Dollar"],
  ["BND", 2, "B$", "Brunei Dollar"],
  ["BOB", 2, "Bs", "Bolivian Boliviano"],
  ["BRL", 2, "R$", "Brazilian Real"],
  ["BSD", 2, "$", "Bahamian Dollar"],
  ["BTN", 2, "Nu.", "Bhutanese Ngultrum"],
  ["BWP", 2, "P", "Botswanan Pula"],
  ["BYN", 2, "Br", "Belarusian Ruble"],
  ["BZD", 2, "BZ$", "Belize Dollar"],
  ["CAD", 2, "C$", "Canadian Dollar"],
  ["CDF", 2, "FC", "Congolese Franc"],
  ["CHF", 2, "Fr", "Swiss Franc"],
  ["CLF", 4, null, "Chilean Unit of Account (UF)"],
  ["CLP", 0, "$", "Chilean Peso"],
  ["CNY", 2, "¥", "Chinese Yuan"],
  ["COP", 2, "$", "Colombian Peso"],
  ["CRC", 2, "₡", "Costa Rican Colón"],
  ["CUP", 2, "$", "Cuban Peso"],
  ["CVE", 2, "$", "Cape Verdean Escudo"],
  ["CZK", 2, "Kč", "Czech Koruna"],
  ["DJF", 0, "Fdj", "Djiboutian Franc"],
  ["DKK", 2, "kr", "Danish Krone"],
  ["DOP", 2, "RD$", "Dominican Peso"],
  ["DZD", 2, "د.ج", "Algerian Dinar"],
  ["EGP", 2, "£", "Egyptian Pound"],
  ["ERN", 2, "Nfk", "Eritrean Nakfa"],
  ["ETB", 2, "Br", "Ethiopian Birr"],
  ["EUR", 2, "€", "Euro"],
  ["FJD", 2, "$", "Fijian Dollar"],
  ["FKP", 2, "£", "Falkland Islands Pound"],
  ["GBP", 2, "£", "British Pound"],
  ["GEL", 2, "₾", "Georgian Lari"],
  ["GHS", 2, "₵", "Ghanaian Cedi"],
  ["GIP", 2, "£", "Gibraltar Pound"],
  ["GMD", 2, "D", "Gambian Dalasi"],
  ["GNF", 0, "FG", "Guinean Franc"],
  ["GTQ", 2, "Q", "Guatemalan Quetzal"],
  ["GYD", 2, "$", "Guyanaese Dollar"],
  ["HKD", 2, "HK$", "Hong Kong Dollar"],
  ["HNL", 2, "L", "Honduran Lempira"],
  ["HTG", 2, "G", "Haitian Gourde"],
  ["HUF", 2, "Ft", "Hungarian Forint"],
  ["IDR", 2, "Rp", "Indonesian Rupiah"],
  ["ILS", 2, "₪", "Israeli New Shekel"],
  ["INR", 2, "₹", "Indian Rupee"],
  ["IQD", 3, "ع.د", "Iraqi Dinar"],
  ["IRR", 2, "﷼", "Iranian Rial"],
  ["ISK", 0, "kr", "Icelandic Króna"],
  ["JMD", 2, "J$", "Jamaican Dollar"],
  ["JOD", 3, "د.ا", "Jordanian Dinar"],
  ["JPY", 0, "¥", "Japanese Yen"],
  ["KES", 2, "KSh", "Kenyan Shilling"],
  ["KGS", 2, "с", "Kyrgystani Som"],
  ["KHR", 2, "៛", "Cambodian Riel"],
  ["KMF", 0, "CF", "Comorian Franc"],
  ["KPW", 2, "₩", "North Korean Won"],
  ["KRW", 0, "₩", "South Korean Won"],
  ["KWD", 3, "د.ك", "Kuwaiti Dinar"],
  ["KYD", 2, "$", "Cayman Islands Dollar"],
  ["KZT", 2, "₸", "Kazakhstani Tenge"],
  ["LAK", 2, "₭", "Laotian Kip"],
  ["LBP", 2, "ل.ل", "Lebanese Pound"],
  ["LKR", 2, "Rs", "Sri Lankan Rupee"],
  ["LRD", 2, "$", "Liberian Dollar"],
  ["LSL", 2, "L", "Lesotho Loti"],
  ["LYD", 3, "ل.د", "Libyan Dinar"],
  ["MAD", 2, "د.م.", "Moroccan Dirham"],
  ["MDL", 2, "L", "Moldovan Leu"],
  ["MGA", 2, "Ar", "Malagasy Ariary"],
  ["MKD", 2, "ден", "Macedonian Denar"],
  ["MMK", 2, "K", "Myanmar Kyat"],
  ["MNT", 2, "₮", "Mongolian Tugrik"],
  ["MOP", 2, "MOP$", "Macanese Pataca"],
  ["MRU", 2, "UM", "Mauritanian Ouguiya"],
  ["MUR", 2, "₨", "Mauritian Rupee"],
  ["MVR", 2, ".ރ", "Maldivian Rufiyaa"],
  ["MWK", 2, "MK", "Malawian Kwacha"],
  ["MXN", 2, "$", "Mexican Peso"],
  ["MYR", 2, "RM", "Malaysian Ringgit"],
  ["MZN", 2, "MT", "Mozambican Metical"],
  ["NAD", 2, "$", "Namibian Dollar"],
  ["NGN", 2, "₦", "Nigerian Naira"],
  ["NIO", 2, "C$", "Nicaraguan Córdoba"],
  ["NOK", 2, "kr", "Norwegian Krone"],
  ["NPR", 2, "₨", "Nepalese Rupee"],
  ["NZD", 2, "NZ$", "New Zealand Dollar"],
  ["OMR", 3, "ر.ع.", "Omani Rial"],
  ["PAB", 2, "B/.", "Panamanian Balboa"],
  ["PEN", 2, "S/", "Peruvian Sol"],
  ["PGK", 2, "K", "Papua New Guinean Kina"],
  ["PHP", 2, "₱", "Philippine Peso"],
  ["PKR", 2, "₨", "Pakistani Rupee"],
  ["PLN", 2, "zł", "Polish Złoty"],
  ["PYG", 0, "₲", "Paraguayan Guarani"],
  ["QAR", 2, "ر.ق", "Qatari Rial"],
  ["RON", 2, "lei", "Romanian Leu"],
  ["RSD", 2, "дин.", "Serbian Dinar"],
  ["RUB", 2, "₽", "Russian Ruble"],
  ["RWF", 0, "FRw", "Rwandan Franc"],
  ["SAR", 2, "ر.س", "Saudi Riyal"],
  ["SBD", 2, "$", "Solomon Islands Dollar"],
  ["SCR", 2, "₨", "Seychellois Rupee"],
  ["SDG", 2, "ج.س.", "Sudanese Pound"],
  ["SEK", 2, "kr", "Swedish Krona"],
  ["SGD", 2, "S$", "Singapore Dollar"],
  ["SHP", 2, "£", "Saint Helena Pound"],
  ["SLE", 2, "Le", "Sierra Leonean Leone"],
  ["SOS", 2, "S", "Somali Shilling"],
  ["SRD", 2, "$", "Surinamese Dollar"],
  ["SSP", 2, "£", "South Sudanese Pound"],
  ["STN", 2, "Db", "São Tomé and Príncipe Dobra"],
  ["SVC", 2, "₡", "Salvadoran Colón"],
  ["SYP", 2, "£", "Syrian Pound"],
  ["SZL", 2, "L", "Swazi Lilangeni"],
  ["THB", 2, "฿", "Thai Baht"],
  ["TJS", 2, "ЅМ", "Tajikistani Somoni"],
  ["TMT", 2, "m", "Turkmenistani Manat"],
  ["TND", 3, "د.ت", "Tunisian Dinar"],
  ["TOP", 2, "T$", "Tongan Paʻanga"],
  ["TRY", 2, "₺", "Turkish Lira"],
  ["TTD", 2, "TT$", "Trinidad and Tobago Dollar"],
  ["TWD", 2, "NT$", "New Taiwan Dollar"],
  ["TZS", 2, "TSh", "Tanzanian Shilling"],
  ["UAH", 2, "₴", "Ukrainian Hryvnia"],
  ["UGX", 0, "USh", "Ugandan Shilling"],
  ["USD", 2, "$", "US Dollar"],
  ["UYU", 2, "$U", "Uruguayan Peso"],
  ["UYW", 4, null, "Uruguayan Nominal Wage Index Unit"],
  ["UZS", 2, "so'm", "Uzbekistani Som"],
  ["VES", 2, "Bs.", "Venezuelan Bolívar"],
  ["VND", 0, "₫", "Vietnamese Dong"],
  ["VUV", 0, "VT", "Vanuatu Vatu"],
  ["WST", 2, "T", "Samoan Tala"],
  ["XAF", 0, "FCFA", "Central African CFA Franc"],
  ["XCD", 2, "$", "East Caribbean Dollar"],
  ["XOF", 0, "CFA", "West African CFA Franc"],
  ["XPF", 0, "₣", "CFP Franc"],
  ["YER", 2, "﷼", "Yemeni Rial"],
  ["ZAR", 2, "R", "South African Rand"],
  ["ZMW", 2, "ZK", "Zambian Kwacha"],
  ["ZWG", 2, "ZiG", "Zimbabwe Gold"],
];

/**
 * Codes Splitwise accepts that are NOT active ISO 4217 currencies.
 *
 * Almost all are demonetised — their users have historical expenses in them, so
 * the API still lists them. We must too: `expenses.currency_code` is a foreign
 * key, so omitting one makes importing that history impossible.
 *
 * Verified against fixtures/splitwise/get_currencies.json (153 codes). Symbols
 * are Splitwise's own `unit` values so display matches theirs.
 */
const LEGACY_RAW: Array<[string, number, string | null, string]> = [
  // Not a fiat currency; 8 decimals is the satoshi convention, which is why
  // the decimal_places CHECK in migrations/001 allows up to 8.
  ["BTC", 8, "฿", "Bitcoin"],
  ["BYR", 0, "BYR", "Belarusian Ruble (pre-2016, redenominated to BYN)"],
  // Not an ISO code and not attributable to any country — appears in
  // Splitwise's list regardless. Included so imports never fail on it.
  ["CMG", 2, "CMg", "Unrecognised Splitwise code"],
  ["CUC", 2, "CUC$", "Cuban Convertible Peso (withdrawn 2021)"],
  ["HRK", 2, "HRK", "Croatian Kuna (replaced by EUR, 2023)"],
  ["LTL", 2, "Lt", "Lithuanian Litas (replaced by EUR, 2015)"],
  ["SLL", 2, "SLL", "Sierra Leonean Leone (pre-2022, redenominated to SLE)"],
  ["STD", 2, "Db", "São Tomé and Príncipe Dobra (pre-2018, now STN)"],
  ["VEF", 2, "Bs", "Venezuelan Bolívar (pre-2018, now VES)"],
  ["XCG", 2, "Cg", "Caribbean Guilder (successor to ANG)"],
  ["ZWL", 2, "Z$", "Zimbabwe Dollar (pre-2024, now ZWG)"],
];

export const LEGACY_CURRENCIES: CurrencyDefinition[] = LEGACY_RAW.map(
  ([code, decimals, symbol, name]) => ({ code, decimals, symbol, name }),
);

/** Set of codes that are legacy rather than active ISO 4217. */
export const LEGACY_CODES = new Set(LEGACY_CURRENCIES.map((c) => c.code));

export const CURRENCIES: CurrencyDefinition[] = [
  ...RAW.map(([code, decimals, symbol, name]) => ({ code, decimals, symbol, name })),
  ...LEGACY_CURRENCIES,
].sort((a, b) => a.code.localeCompare(b.code));

/** Currencies whose exponent is not 2 — the ones that break naive x100 code. */
export const NON_STANDARD_DECIMALS = CURRENCIES.filter((c) => c.decimals !== 2);
