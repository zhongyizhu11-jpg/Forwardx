/**
 * 离线城市表：给「主机位置」的下拉用。
 *
 * 按 IP 自动定位对机房网段经常是错的（香港的机器落在深圳、美国的落错州），
 * 用户得能自己指定。做成随包带的静态表而不是调第三方地名接口，是因为面板
 * 常跑在没有外网或外网很差的内网机上；~300 个条目覆盖常见的机房城市和各国
 * 主要城市就够了，再细的地方走「自定义经纬度」。
 *
 * 坐标取城市中心，精确到小数点后四位（十几米），地图上够用。
 */

export type GeoCity = {
  /** ISO 3166-1 alpha-2，大写 */
  code: string;
  /** 国家/地区中文名 */
  country: string;
  /** 国家/地区英文名，给搜索用（输 japan 能找到东京） */
  countryEn: string;
  /** 城市中文名 */
  name: string;
  /** 城市英文名 */
  nameEn: string;
  lat: number;
  lng: number;
};

const COUNTRIES: Record<string, [zh: string, en: string]> = {
  CN: ["中国", "China"],
  HK: ["中国香港", "Hong Kong"],
  MO: ["中国澳门", "Macao"],
  TW: ["中国台湾", "Taiwan"],
  JP: ["日本", "Japan"],
  KR: ["韩国", "South Korea"],
  SG: ["新加坡", "Singapore"],
  MY: ["马来西亚", "Malaysia"],
  TH: ["泰国", "Thailand"],
  ID: ["印度尼西亚", "Indonesia"],
  PH: ["菲律宾", "Philippines"],
  VN: ["越南", "Vietnam"],
  KH: ["柬埔寨", "Cambodia"],
  LA: ["老挝", "Laos"],
  MM: ["缅甸", "Myanmar"],
  IN: ["印度", "India"],
  PK: ["巴基斯坦", "Pakistan"],
  BD: ["孟加拉国", "Bangladesh"],
  LK: ["斯里兰卡", "Sri Lanka"],
  NP: ["尼泊尔", "Nepal"],
  MN: ["蒙古", "Mongolia"],
  KZ: ["哈萨克斯坦", "Kazakhstan"],
  UZ: ["乌兹别克斯坦", "Uzbekistan"],
  KG: ["吉尔吉斯斯坦", "Kyrgyzstan"],
  AU: ["澳大利亚", "Australia"],
  NZ: ["新西兰", "New Zealand"],
  AE: ["阿联酋", "United Arab Emirates"],
  SA: ["沙特阿拉伯", "Saudi Arabia"],
  QA: ["卡塔尔", "Qatar"],
  BH: ["巴林", "Bahrain"],
  KW: ["科威特", "Kuwait"],
  OM: ["阿曼", "Oman"],
  IL: ["以色列", "Israel"],
  TR: ["土耳其", "Turkey"],
  IR: ["伊朗", "Iran"],
  IQ: ["伊拉克", "Iraq"],
  JO: ["约旦", "Jordan"],
  RU: ["俄罗斯", "Russia"],
  UA: ["乌克兰", "Ukraine"],
  BY: ["白俄罗斯", "Belarus"],
  DE: ["德国", "Germany"],
  NL: ["荷兰", "Netherlands"],
  GB: ["英国", "United Kingdom"],
  FR: ["法国", "France"],
  ES: ["西班牙", "Spain"],
  PT: ["葡萄牙", "Portugal"],
  IT: ["意大利", "Italy"],
  CH: ["瑞士", "Switzerland"],
  AT: ["奥地利", "Austria"],
  BE: ["比利时", "Belgium"],
  LU: ["卢森堡", "Luxembourg"],
  IE: ["爱尔兰", "Ireland"],
  PL: ["波兰", "Poland"],
  CZ: ["捷克", "Czechia"],
  HU: ["匈牙利", "Hungary"],
  RO: ["罗马尼亚", "Romania"],
  BG: ["保加利亚", "Bulgaria"],
  GR: ["希腊", "Greece"],
  RS: ["塞尔维亚", "Serbia"],
  HR: ["克罗地亚", "Croatia"],
  SK: ["斯洛伐克", "Slovakia"],
  SI: ["斯洛文尼亚", "Slovenia"],
  SE: ["瑞典", "Sweden"],
  FI: ["芬兰", "Finland"],
  NO: ["挪威", "Norway"],
  DK: ["丹麦", "Denmark"],
  IS: ["冰岛", "Iceland"],
  EE: ["爱沙尼亚", "Estonia"],
  LV: ["拉脱维亚", "Latvia"],
  LT: ["立陶宛", "Lithuania"],
  MD: ["摩尔多瓦", "Moldova"],
  CY: ["塞浦路斯", "Cyprus"],
  MT: ["马耳他", "Malta"],
  GE: ["格鲁吉亚", "Georgia"],
  AM: ["亚美尼亚", "Armenia"],
  AZ: ["阿塞拜疆", "Azerbaijan"],
  US: ["美国", "United States"],
  CA: ["加拿大", "Canada"],
  MX: ["墨西哥", "Mexico"],
  BR: ["巴西", "Brazil"],
  AR: ["阿根廷", "Argentina"],
  CL: ["智利", "Chile"],
  CO: ["哥伦比亚", "Colombia"],
  PE: ["秘鲁", "Peru"],
  EC: ["厄瓜多尔", "Ecuador"],
  UY: ["乌拉圭", "Uruguay"],
  PY: ["巴拉圭", "Paraguay"],
  BO: ["玻利维亚", "Bolivia"],
  VE: ["委内瑞拉", "Venezuela"],
  PA: ["巴拿马", "Panama"],
  CR: ["哥斯达黎加", "Costa Rica"],
  PR: ["波多黎各", "Puerto Rico"],
  DO: ["多米尼加", "Dominican Republic"],
  GT: ["危地马拉", "Guatemala"],
  ZA: ["南非", "South Africa"],
  NG: ["尼日利亚", "Nigeria"],
  KE: ["肯尼亚", "Kenya"],
  EG: ["埃及", "Egypt"],
  MA: ["摩洛哥", "Morocco"],
  DZ: ["阿尔及利亚", "Algeria"],
  TN: ["突尼斯", "Tunisia"],
  GH: ["加纳", "Ghana"],
  ET: ["埃塞俄比亚", "Ethiopia"],
  TZ: ["坦桑尼亚", "Tanzania"],
  UG: ["乌干达", "Uganda"],
  RW: ["卢旺达", "Rwanda"],
  SN: ["塞内加尔", "Senegal"],
  CI: ["科特迪瓦", "Côte d'Ivoire"],
  CM: ["喀麦隆", "Cameroon"],
  AO: ["安哥拉", "Angola"],
  MU: ["毛里求斯", "Mauritius"],
};

type Row = [code: string, name: string, nameEn: string, lat: number, lng: number];

const ROWS: Row[] = [
  // ===== 中国大陆：省会/直辖市 + 机房集中的城市 =====
  ["CN", "北京", "Beijing", 39.9042, 116.4074],
  ["CN", "上海", "Shanghai", 31.2304, 121.4737],
  ["CN", "广州", "Guangzhou", 23.1291, 113.2644],
  ["CN", "深圳", "Shenzhen", 22.5431, 114.0579],
  ["CN", "杭州", "Hangzhou", 30.2741, 120.1551],
  ["CN", "成都", "Chengdu", 30.5728, 104.0668],
  ["CN", "重庆", "Chongqing", 29.563, 106.5516],
  ["CN", "武汉", "Wuhan", 30.5928, 114.3055],
  ["CN", "南京", "Nanjing", 32.0603, 118.7969],
  ["CN", "福州", "Fuzhou", 26.0745, 119.2965],
  ["CN", "厦门", "Xiamen", 24.4798, 118.0894],
  ["CN", "泉州", "Quanzhou", 24.8741, 118.6757],
  ["CN", "青岛", "Qingdao", 36.0671, 120.3826],
  ["CN", "济南", "Jinan", 36.6512, 117.1201],
  ["CN", "烟台", "Yantai", 37.4638, 121.4479],
  ["CN", "郑州", "Zhengzhou", 34.7466, 113.6254],
  ["CN", "洛阳", "Luoyang", 34.6197, 112.454],
  ["CN", "长沙", "Changsha", 28.2282, 112.9388],
  ["CN", "西安", "Xi'an", 34.3416, 108.9398],
  ["CN", "天津", "Tianjin", 39.3434, 117.3616],
  ["CN", "苏州", "Suzhou", 31.2989, 120.5853],
  ["CN", "无锡", "Wuxi", 31.4912, 120.3119],
  ["CN", "常州", "Changzhou", 31.8106, 119.9741],
  ["CN", "徐州", "Xuzhou", 34.2044, 117.2857],
  ["CN", "扬州", "Yangzhou", 32.3932, 119.4128],
  ["CN", "宿迁", "Suqian", 33.963, 118.2751],
  ["CN", "连云港", "Lianyungang", 34.5967, 119.2214],
  ["CN", "宁波", "Ningbo", 29.8683, 121.544],
  ["CN", "温州", "Wenzhou", 27.9938, 120.6994],
  ["CN", "嘉兴", "Jiaxing", 30.7522, 120.755],
  ["CN", "绍兴", "Shaoxing", 29.9958, 120.5862],
  ["CN", "金华", "Jinhua", 29.0791, 119.6474],
  ["CN", "台州", "Taizhou", 28.6564, 121.4208],
  ["CN", "东莞", "Dongguan", 23.0207, 113.7518],
  ["CN", "佛山", "Foshan", 23.0218, 113.1219],
  ["CN", "珠海", "Zhuhai", 22.271, 113.5767],
  ["CN", "中山", "Zhongshan", 22.5176, 113.3928],
  ["CN", "惠州", "Huizhou", 23.1115, 114.4152],
  ["CN", "汕头", "Shantou", 23.3535, 116.6822],
  ["CN", "湛江", "Zhanjiang", 21.2707, 110.3594],
  ["CN", "南宁", "Nanning", 22.817, 108.3665],
  ["CN", "桂林", "Guilin", 25.2736, 110.29],
  ["CN", "昆明", "Kunming", 25.0389, 102.7183],
  ["CN", "贵阳", "Guiyang", 26.647, 106.6302],
  ["CN", "哈尔滨", "Harbin", 45.8038, 126.535],
  ["CN", "长春", "Changchun", 43.8171, 125.3235],
  ["CN", "沈阳", "Shenyang", 41.8057, 123.4315],
  ["CN", "大连", "Dalian", 38.914, 121.6147],
  ["CN", "乌鲁木齐", "Urumqi", 43.8256, 87.6168],
  ["CN", "拉萨", "Lhasa", 29.652, 91.1721],
  ["CN", "海口", "Haikou", 20.0444, 110.1999],
  ["CN", "三亚", "Sanya", 18.2528, 109.5119],
  ["CN", "石家庄", "Shijiazhuang", 38.0428, 114.5149],
  ["CN", "唐山", "Tangshan", 39.6305, 118.1802],
  ["CN", "保定", "Baoding", 38.8671, 115.4845],
  ["CN", "廊坊", "Langfang", 39.5186, 116.703],
  ["CN", "张家口", "Zhangjiakou", 40.7686, 114.886],
  ["CN", "秦皇岛", "Qinhuangdao", 39.9354, 119.6005],
  ["CN", "太原", "Taiyuan", 37.8706, 112.5489],
  ["CN", "呼和浩特", "Hohhot", 40.8424, 111.749],
  ["CN", "乌兰察布", "Ulanqab", 40.9946, 113.1336],
  ["CN", "合肥", "Hefei", 31.8206, 117.2272],
  ["CN", "南昌", "Nanchang", 28.682, 115.8579],
  ["CN", "兰州", "Lanzhou", 36.0611, 103.8343],
  ["CN", "西宁", "Xining", 36.6171, 101.7782],
  ["CN", "银川", "Yinchuan", 38.4872, 106.2309],
  ["CN", "中卫", "Zhongwei", 37.5149, 105.1967],
  // ===== 港澳台 =====
  ["HK", "香港", "Hong Kong", 22.3193, 114.1694],
  ["MO", "澳门", "Macau", 22.1987, 113.5439],
  ["TW", "台北", "Taipei", 25.033, 121.5654],
  ["TW", "新北", "New Taipei", 25.012, 121.4657],
  ["TW", "桃园", "Taoyuan", 24.9936, 121.301],
  ["TW", "新竹", "Hsinchu", 24.8138, 120.9675],
  ["TW", "台中", "Taichung", 24.1477, 120.6736],
  ["TW", "彰化", "Changhua", 24.0518, 120.5161],
  ["TW", "台南", "Tainan", 22.9997, 120.227],
  ["TW", "高雄", "Kaohsiung", 22.6273, 120.3014],
  // ===== 东亚 =====
  ["JP", "东京", "Tokyo", 35.6762, 139.6503],
  ["JP", "横滨", "Yokohama", 35.4437, 139.638],
  ["JP", "大阪", "Osaka", 34.6937, 135.5023],
  ["JP", "名古屋", "Nagoya", 35.1815, 136.9066],
  ["JP", "福冈", "Fukuoka", 33.5904, 130.4017],
  ["JP", "札幌", "Sapporo", 43.0618, 141.3545],
  ["JP", "那霸", "Naha", 26.2124, 127.6809],
  ["KR", "首尔", "Seoul", 37.5665, 126.978],
  ["KR", "仁川", "Incheon", 37.4563, 126.7052],
  ["KR", "釜山", "Busan", 35.1796, 129.0756],
  ["MN", "乌兰巴托", "Ulaanbaatar", 47.8864, 106.9057],
  // ===== 东南亚 =====
  ["SG", "新加坡", "Singapore", 1.3521, 103.8198],
  ["MY", "吉隆坡", "Kuala Lumpur", 3.139, 101.6869],
  ["MY", "赛城", "Cyberjaya", 2.9213, 101.6559],
  ["MY", "新山", "Johor Bahru", 1.4927, 103.7414],
  ["MY", "槟城", "Penang", 5.4141, 100.3288],
  ["TH", "曼谷", "Bangkok", 13.7563, 100.5018],
  ["TH", "清迈", "Chiang Mai", 18.7883, 98.9853],
  ["ID", "雅加达", "Jakarta", -6.2088, 106.8456],
  ["ID", "泗水", "Surabaya", -7.2575, 112.7521],
  ["ID", "巴淡", "Batam", 1.0456, 104.0305],
  ["PH", "马尼拉", "Manila", 14.5995, 120.9842],
  ["PH", "宿务", "Cebu", 10.3157, 123.8854],
  ["VN", "河内", "Hanoi", 21.0278, 105.8342],
  ["VN", "胡志明市", "Ho Chi Minh City", 10.8231, 106.6297],
  ["VN", "岘港", "Da Nang", 16.0544, 108.2022],
  ["KH", "金边", "Phnom Penh", 11.5564, 104.9282],
  ["LA", "万象", "Vientiane", 17.9757, 102.6331],
  ["MM", "仰光", "Yangon", 16.8661, 96.1951],
  // ===== 南亚 / 中亚 =====
  ["IN", "孟买", "Mumbai", 19.076, 72.8777],
  ["IN", "新德里", "New Delhi", 28.6139, 77.209],
  ["IN", "班加罗尔", "Bengaluru", 12.9716, 77.5946],
  ["IN", "钦奈", "Chennai", 13.0827, 80.2707],
  ["IN", "海得拉巴", "Hyderabad", 17.385, 78.4867],
  ["IN", "浦那", "Pune", 18.5204, 73.8567],
  ["IN", "加尔各答", "Kolkata", 22.5726, 88.3639],
  ["PK", "卡拉奇", "Karachi", 24.8607, 67.0011],
  ["PK", "拉合尔", "Lahore", 31.5204, 74.3587],
  ["PK", "伊斯兰堡", "Islamabad", 33.6844, 73.0479],
  ["BD", "达卡", "Dhaka", 23.8103, 90.4125],
  ["LK", "科伦坡", "Colombo", 6.9271, 79.8612],
  ["NP", "加德满都", "Kathmandu", 27.7172, 85.324],
  ["KZ", "阿拉木图", "Almaty", 43.222, 76.8512],
  ["KZ", "阿斯塔纳", "Astana", 51.1694, 71.4491],
  ["UZ", "塔什干", "Tashkent", 41.2995, 69.2401],
  ["KG", "比什凯克", "Bishkek", 42.8746, 74.5698],
  // ===== 大洋洲 =====
  ["AU", "悉尼", "Sydney", -33.8688, 151.2093],
  ["AU", "墨尔本", "Melbourne", -37.8136, 144.9631],
  ["AU", "布里斯班", "Brisbane", -27.4698, 153.0251],
  ["AU", "珀斯", "Perth", -31.9505, 115.8605],
  ["AU", "阿德莱德", "Adelaide", -34.9285, 138.6007],
  ["AU", "堪培拉", "Canberra", -35.2809, 149.13],
  ["NZ", "奥克兰", "Auckland", -36.8485, 174.7633],
  ["NZ", "惠灵顿", "Wellington", -41.2865, 174.7762],
  // ===== 中东 =====
  ["AE", "迪拜", "Dubai", 25.2048, 55.2708],
  ["AE", "阿布扎比", "Abu Dhabi", 24.4539, 54.3773],
  ["SA", "利雅得", "Riyadh", 24.7136, 46.6753],
  ["SA", "吉达", "Jeddah", 21.4858, 39.1925],
  ["QA", "多哈", "Doha", 25.2854, 51.531],
  ["BH", "麦纳麦", "Manama", 26.2285, 50.586],
  ["KW", "科威特城", "Kuwait City", 29.3759, 47.9774],
  ["OM", "马斯喀特", "Muscat", 23.588, 58.3829],
  ["IL", "特拉维夫", "Tel Aviv", 32.0853, 34.7818],
  ["TR", "伊斯坦布尔", "Istanbul", 41.0082, 28.9784],
  ["TR", "安卡拉", "Ankara", 39.9334, 32.8597],
  ["TR", "伊兹密尔", "Izmir", 38.4237, 27.1428],
  ["IR", "德黑兰", "Tehran", 35.6892, 51.389],
  ["IQ", "巴格达", "Baghdad", 33.3152, 44.3661],
  ["JO", "安曼", "Amman", 31.9454, 35.9284],
  // ===== 俄罗斯 / 东欧 =====
  ["RU", "莫斯科", "Moscow", 55.7558, 37.6173],
  ["RU", "圣彼得堡", "Saint Petersburg", 59.9311, 30.3609],
  ["RU", "新西伯利亚", "Novosibirsk", 55.0084, 82.9357],
  ["RU", "叶卡捷琳堡", "Yekaterinburg", 56.8389, 60.6057],
  ["RU", "哈巴罗夫斯克", "Khabarovsk", 48.4827, 135.0838],
  ["RU", "符拉迪沃斯托克", "Vladivostok", 43.1155, 131.8855],
  ["UA", "基辅", "Kyiv", 50.4501, 30.5234],
  ["UA", "哈尔科夫", "Kharkiv", 49.9935, 36.2304],
  ["BY", "明斯克", "Minsk", 53.9006, 27.559],
  ["MD", "基希讷乌", "Chisinau", 47.0105, 28.8638],
  ["GE", "第比利斯", "Tbilisi", 41.7151, 44.8271],
  ["AM", "埃里温", "Yerevan", 40.1792, 44.4991],
  ["AZ", "巴库", "Baku", 40.4093, 49.8671],
  // ===== 西欧 / 中欧 =====
  ["DE", "法兰克福", "Frankfurt", 50.1109, 8.6821],
  ["DE", "柏林", "Berlin", 52.52, 13.405],
  ["DE", "慕尼黑", "Munich", 48.1351, 11.582],
  ["DE", "杜塞尔多夫", "Dusseldorf", 51.2277, 6.7735],
  ["DE", "汉堡", "Hamburg", 53.5511, 9.9937],
  ["DE", "纽伦堡", "Nuremberg", 49.4521, 11.0767],
  ["DE", "法尔肯施泰因", "Falkenstein", 50.4779, 12.3713],
  ["NL", "阿姆斯特丹", "Amsterdam", 52.3676, 4.9041],
  ["NL", "鹿特丹", "Rotterdam", 51.9244, 4.4777],
  ["NL", "埃因霍温", "Eindhoven", 51.4416, 5.4697],
  ["GB", "伦敦", "London", 51.5074, -0.1278],
  ["GB", "曼彻斯特", "Manchester", 53.4808, -2.2426],
  ["GB", "伯明翰", "Birmingham", 52.4862, -1.8904],
  ["GB", "爱丁堡", "Edinburgh", 55.9533, -3.1883],
  ["GB", "卡迪夫", "Cardiff", 51.4816, -3.1791],
  ["FR", "巴黎", "Paris", 48.8566, 2.3522],
  ["FR", "马赛", "Marseille", 43.2965, 5.3698],
  ["FR", "里昂", "Lyon", 45.764, 4.8357],
  ["FR", "鲁贝", "Roubaix", 50.6942, 3.1746],
  ["FR", "格拉沃利讷", "Gravelines", 50.9866, 2.1281],
  ["FR", "斯特拉斯堡", "Strasbourg", 48.5734, 7.7521],
  ["ES", "马德里", "Madrid", 40.4168, -3.7038],
  ["ES", "巴塞罗那", "Barcelona", 41.3874, 2.1686],
  ["PT", "里斯本", "Lisbon", 38.7223, -9.1393],
  ["PT", "波尔图", "Porto", 41.1579, -8.6291],
  ["IT", "米兰", "Milan", 45.4642, 9.19],
  ["IT", "罗马", "Rome", 41.9028, 12.4964],
  ["CH", "苏黎世", "Zurich", 47.3769, 8.5417],
  ["CH", "日内瓦", "Geneva", 46.2044, 6.1432],
  ["AT", "维也纳", "Vienna", 48.2082, 16.3738],
  ["BE", "布鲁塞尔", "Brussels", 50.8503, 4.3517],
  ["LU", "卢森堡", "Luxembourg", 49.6116, 6.1319],
  ["IE", "都柏林", "Dublin", 53.3498, -6.2603],
  ["PL", "华沙", "Warsaw", 52.2297, 21.0122],
  ["PL", "波兹南", "Poznan", 52.4064, 16.9252],
  ["CZ", "布拉格", "Prague", 50.0755, 14.4378],
  ["HU", "布达佩斯", "Budapest", 47.4979, 19.0402],
  ["RO", "布加勒斯特", "Bucharest", 44.4268, 26.1025],
  ["BG", "索非亚", "Sofia", 42.6977, 23.3219],
  ["GR", "雅典", "Athens", 37.9838, 23.7275],
  ["RS", "贝尔格莱德", "Belgrade", 44.7866, 20.4489],
  ["HR", "萨格勒布", "Zagreb", 45.815, 15.9819],
  ["SK", "布拉迪斯拉发", "Bratislava", 48.1486, 17.1077],
  ["SI", "卢布尔雅那", "Ljubljana", 46.0569, 14.5058],
  ["CY", "尼科西亚", "Nicosia", 35.1856, 33.3823],
  ["CY", "利马索尔", "Limassol", 34.7071, 33.0226],
  ["MT", "瓦莱塔", "Valletta", 35.8989, 14.5146],
  // ===== 北欧 / 波罗的海 =====
  ["SE", "斯德哥尔摩", "Stockholm", 59.3293, 18.0686],
  ["SE", "哥德堡", "Gothenburg", 57.7089, 11.9746],
  ["FI", "赫尔辛基", "Helsinki", 60.1699, 24.9384],
  ["NO", "奥斯陆", "Oslo", 59.9139, 10.7522],
  ["DK", "哥本哈根", "Copenhagen", 55.6761, 12.5683],
  ["IS", "雷克雅未克", "Reykjavik", 64.1466, -21.9426],
  ["EE", "塔林", "Tallinn", 59.437, 24.7536],
  ["LV", "里加", "Riga", 56.9496, 24.1052],
  ["LT", "维尔纽斯", "Vilnius", 54.6872, 25.2797],
  // ===== 美国 =====
  ["US", "洛杉矶", "Los Angeles", 34.0522, -118.2437],
  ["US", "圣何塞", "San Jose", 37.3382, -121.8863],
  ["US", "圣克拉拉", "Santa Clara", 37.3541, -121.9552],
  ["US", "弗里蒙特", "Fremont", 37.5485, -121.9886],
  ["US", "旧金山", "San Francisco", 37.7749, -122.4194],
  ["US", "萨克拉门托", "Sacramento", 38.5816, -121.4944],
  ["US", "圣迭戈", "San Diego", 32.7157, -117.1611],
  ["US", "西雅图", "Seattle", 47.6062, -122.3321],
  ["US", "塔科马", "Tacoma", 47.2529, -122.4443],
  ["US", "斯波坎", "Spokane", 47.6588, -117.426],
  ["US", "波特兰", "Portland", 45.5152, -122.6784],
  ["US", "希尔斯伯勒", "Hillsboro", 45.5229, -122.9898],
  ["US", "拉斯维加斯", "Las Vegas", 36.1699, -115.1398],
  ["US", "里诺", "Reno", 39.5296, -119.8138],
  ["US", "凤凰城", "Phoenix", 33.4484, -112.074],
  ["US", "阿尔伯克基", "Albuquerque", 35.0844, -106.6504],
  ["US", "博伊西", "Boise", 43.615, -116.2023],
  ["US", "盐湖城", "Salt Lake City", 40.7608, -111.891],
  ["US", "丹佛", "Denver", 39.7392, -104.9903],
  ["US", "夏延", "Cheyenne", 41.14, -104.8202],
  ["US", "达拉斯", "Dallas", 32.7767, -96.797],
  ["US", "休斯顿", "Houston", 29.7604, -95.3698],
  ["US", "奥斯汀", "Austin", 30.2672, -97.7431],
  ["US", "圣安东尼奥", "San Antonio", 29.4241, -98.4936],
  ["US", "俄克拉荷马城", "Oklahoma City", 35.4676, -97.5164],
  ["US", "堪萨斯城", "Kansas City", 39.0997, -94.5786],
  ["US", "圣路易斯", "St. Louis", 38.627, -90.1994],
  ["US", "得梅因", "Des Moines", 41.5868, -93.625],
  ["US", "康瑟尔布拉夫斯", "Council Bluffs", 41.2619, -95.8608],
  ["US", "明尼阿波利斯", "Minneapolis", 44.9778, -93.265],
  ["US", "密尔沃基", "Milwaukee", 43.0389, -87.9065],
  ["US", "芝加哥", "Chicago", 41.8781, -87.6298],
  ["US", "印第安纳波利斯", "Indianapolis", 39.7684, -86.1581],
  ["US", "底特律", "Detroit", 42.3314, -83.0458],
  ["US", "哥伦布", "Columbus", 39.9612, -82.9988],
  ["US", "辛辛那提", "Cincinnati", 39.1031, -84.512],
  ["US", "克利夫兰", "Cleveland", 41.4993, -81.6944],
  ["US", "匹兹堡", "Pittsburgh", 40.4406, -79.9959],
  ["US", "布法罗", "Buffalo", 42.8864, -78.8784],
  ["US", "纳什维尔", "Nashville", 36.1627, -86.7816],
  ["US", "孟菲斯", "Memphis", 35.1495, -90.049],
  ["US", "新奥尔良", "New Orleans", 29.9511, -90.0715],
  ["US", "亚特兰大", "Atlanta", 33.749, -84.388],
  ["US", "夏洛特", "Charlotte", 35.2271, -80.8431],
  ["US", "罗利", "Raleigh", 35.7796, -78.6382],
  ["US", "杰克逊维尔", "Jacksonville", 30.3322, -81.6557],
  ["US", "奥兰多", "Orlando", 28.5383, -81.3792],
  ["US", "坦帕", "Tampa", 27.9506, -82.4572],
  ["US", "迈阿密", "Miami", 25.7617, -80.1918],
  ["US", "里士满", "Richmond", 37.5407, -77.436],
  ["US", "阿什本", "Ashburn", 39.0438, -77.4874],
  ["US", "华盛顿", "Washington", 38.9072, -77.0369],
  ["US", "巴尔的摩", "Baltimore", 39.2904, -76.6122],
  ["US", "费城", "Philadelphia", 39.9526, -75.1652],
  ["US", "纽瓦克", "Newark", 40.7357, -74.1724],
  ["US", "纽约", "New York", 40.7128, -74.006],
  ["US", "波士顿", "Boston", 42.3601, -71.0589],
  ["US", "檀香山", "Honolulu", 21.3069, -157.8583],
  ["US", "安克雷奇", "Anchorage", 61.2181, -149.9003],
  // ===== 加拿大 / 墨西哥 / 加勒比 =====
  ["CA", "多伦多", "Toronto", 43.6532, -79.3832],
  ["CA", "温哥华", "Vancouver", 49.2827, -123.1207],
  ["CA", "蒙特利尔", "Montreal", 45.5017, -73.5673],
  ["CA", "博阿努瓦", "Beauharnois", 45.3134, -73.8733],
  ["CA", "魁北克城", "Quebec City", 46.8139, -71.208],
  ["CA", "渥太华", "Ottawa", 45.4215, -75.6972],
  ["CA", "卡尔加里", "Calgary", 51.0447, -114.0719],
  ["MX", "墨西哥城", "Mexico City", 19.4326, -99.1332],
  ["MX", "克雷塔罗", "Queretaro", 20.5888, -100.3899],
  ["MX", "瓜达拉哈拉", "Guadalajara", 20.6597, -103.3496],
  ["MX", "蒙特雷", "Monterrey", 25.6866, -100.3161],
  ["PR", "圣胡安", "San Juan", 18.4655, -66.1057],
  ["DO", "圣多明各", "Santo Domingo", 18.4861, -69.9312],
  ["GT", "危地马拉城", "Guatemala City", 14.6349, -90.5069],
  ["CR", "圣何塞（哥斯达黎加）", "San Jose (Costa Rica)", 9.9281, -84.0907],
  ["PA", "巴拿马城", "Panama City", 8.9824, -79.5199],
  // ===== 南美 =====
  ["BR", "圣保罗", "Sao Paulo", -23.5505, -46.6333],
  ["BR", "坎皮纳斯", "Campinas", -22.9056, -47.0608],
  ["BR", "里约热内卢", "Rio de Janeiro", -22.9068, -43.1729],
  ["BR", "巴西利亚", "Brasilia", -15.7975, -47.8919],
  ["BR", "福塔莱萨", "Fortaleza", -3.7319, -38.5267],
  ["AR", "布宜诺斯艾利斯", "Buenos Aires", -34.6037, -58.3816],
  ["CL", "圣地亚哥", "Santiago", -33.4489, -70.6693],
  ["CO", "波哥大", "Bogota", 4.711, -74.0721],
  ["CO", "麦德林", "Medellin", 6.2476, -75.5658],
  ["PE", "利马", "Lima", -12.0464, -77.0428],
  ["EC", "基多", "Quito", -0.1807, -78.4678],
  ["UY", "蒙得维的亚", "Montevideo", -34.9011, -56.1645],
  ["PY", "亚松森", "Asuncion", -25.2637, -57.5759],
  ["BO", "拉巴斯", "La Paz", -16.4897, -68.1193],
  ["VE", "加拉加斯", "Caracas", 10.4806, -66.9036],
  // ===== 非洲 =====
  ["ZA", "约翰内斯堡", "Johannesburg", -26.2041, 28.0473],
  ["ZA", "开普敦", "Cape Town", -33.9249, 18.4241],
  ["ZA", "德班", "Durban", -29.8587, 31.0218],
  ["NG", "拉各斯", "Lagos", 6.5244, 3.3792],
  ["NG", "阿布贾", "Abuja", 9.0765, 7.3986],
  ["KE", "内罗毕", "Nairobi", -1.2921, 36.8219],
  ["KE", "蒙巴萨", "Mombasa", -4.0435, 39.6682],
  ["EG", "开罗", "Cairo", 30.0444, 31.2357],
  ["EG", "亚历山大", "Alexandria", 31.2001, 29.9187],
  ["MA", "卡萨布兰卡", "Casablanca", 33.5731, -7.5898],
  ["MA", "拉巴特", "Rabat", 34.0209, -6.8416],
  ["DZ", "阿尔及尔", "Algiers", 36.7538, 3.0588],
  ["TN", "突尼斯", "Tunis", 36.8065, 10.1815],
  ["GH", "阿克拉", "Accra", 5.6037, -0.187],
  ["ET", "亚的斯亚贝巴", "Addis Ababa", 9.032, 38.7469],
  ["TZ", "达累斯萨拉姆", "Dar es Salaam", -6.7924, 39.2083],
  ["UG", "坎帕拉", "Kampala", 0.3476, 32.5825],
  ["RW", "基加利", "Kigali", -1.9441, 30.0619],
  ["SN", "达喀尔", "Dakar", 14.7167, -17.4677],
  ["CI", "阿比让", "Abidjan", 5.36, -4.0083],
  ["CM", "杜阿拉", "Douala", 4.0511, 9.7679],
  ["AO", "罗安达", "Luanda", -8.839, 13.2894],
  ["MU", "路易港", "Port Louis", -20.1609, 57.5012],
];

export const GEO_CITIES: readonly GeoCity[] = ROWS.map(([code, name, nameEn, lat, lng]) => {
  const country = COUNTRIES[code];
  if (!country) throw new Error(`geoCities: 未登记的国家代码 ${code}`);
  return { code, country: country[0], countryEn: country[1], name, nameEn, lat, lng };
});

/** 国家代码 → 中文名；不在表里的原样返回代码 */
export function geoCountryNameZh(code: string | null | undefined) {
  const normalized = String(code || "").trim().toUpperCase();
  return COUNTRIES[normalized]?.[0] || normalized;
}

/** 下拉选项的稳定键：同一国家里城市英文名不重复 */
export function geoCityKey(city: Pick<GeoCity, "code" | "nameEn">) {
  return `${city.code}/${city.nameEn}`;
}

export function findGeoCityByKey(key: string | null | undefined) {
  const wanted = String(key || "");
  if (!wanted) return null;
  return GEO_CITIES.find((city) => geoCityKey(city) === wanted) || null;
}

/**
 * 主机上存的位置对应到表里哪一条。
 *
 * 手动选城市时 geoRegion 存的是城市中文名，同时也接受英文名 —— 早先自动定位
 * 写进去的 region 是英文，碰巧和表里一样时也能高亮出来。
 */
export function matchGeoCity(host: { geoCountryCode?: string | null; geoRegion?: string | null } | null | undefined) {
  const code = String(host?.geoCountryCode || "").trim().toUpperCase();
  const region = String(host?.geoRegion || "").trim().toLowerCase();
  if (!code || !region) return null;
  return GEO_CITIES.find((city) => city.code === code && (city.name.toLowerCase() === region || city.nameEn.toLowerCase() === region)) || null;
}

/**
 * 搜索：中文名、英文名、国家名（中/英）、ISO 代码都能匹配，多个词要全中。
 * 排序：城市名前缀命中的排前面，其次是城市名包含，再是只命中国家的。
 */
export function searchGeoCities(query: string, limit = 40): GeoCity[] {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return GEO_CITIES.slice(0, limit);
  const scored: Array<{ city: GeoCity; score: number }> = [];
  for (const city of GEO_CITIES) {
    const name = city.name.toLowerCase();
    const nameEn = city.nameEn.toLowerCase();
    const country = city.country.toLowerCase();
    const countryEn = city.countryEn.toLowerCase();
    const code = city.code.toLowerCase();
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      // 两位代码整个命中放最前：输「HK」是要香港，不是 Tas(hk)ent
      if (code === token) score += 4;
      else if (name.startsWith(token) || nameEn.startsWith(token)) score += 3;
      else if (name.includes(token) || nameEn.includes(token)) score += 2;
      else if (country.includes(token) || countryEn.includes(token)) score += 1;
      else { matchedAll = false; break; }
    }
    if (matchedAll) scored.push({ city, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.city);
}
