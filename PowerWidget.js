// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: yellow; icon-glyph: car-battery;

/*
 * Резервне живлення / Backup power — Scriptable widget for iOS (UA + EN).
 * Charge, input/output power and time remaining for portable power stations:
 *   • EcoFlow — official IoT Open API (developer-eu.ecoflow.com)
 *   • Bluetti — BLUETTI cloud (the API behind the official Home Assistant integration)
 *   • Home Assistant / JSON URL — anything else (e.g. Gendome through a bridge)
 * Outage schedule: Yasno (Kyiv) or kiroe.com.ua (Kirovohrad region), by address.
 * Run the script inside the Scriptable app to set up devices.
 */

const VERSION = "1.5.1";
const CONFIG_KEY = "power-widget.config";
const CONFIG_MARKER = "power-widget.configured";
const CACHE_FILE = "power-widget-cache.json";
const ALERTS_FILE = "power-widget-alerts.json";
const VIEWS_FILE = "power-widget-views.json"; // last rendered readings (no secrets), shown while the keychain is locked
// Outage settings (provider, address, queue) and display options. Kept outside the keychain — it holds no
// secrets, and the keychain can't be read while the phone is locked, which froze the schedule until unlock.
const PUBLIC_FILE = "power-widget-public.json";
const UPDATE_FILE = "power-widget-update.json";
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;
const ALERT_REARM_PCT = 3; // hysteresis: alerts re-arm once charge climbs this far above the threshold
const IDLE_W = 5; // below this, input/output counts as zero
// EcoFlow reports 5939/5999 min when a time doesn't apply (no load / no charger): treat ≥ 5900 as "99+ h"
const LONG_MIN = 5900;
// Estimates (no time from the station) use the BLUETTI manual's formula: capacity × η ÷ power, η ≈ 0.9
const EST_EFFICIENCY = 0.9;
const TIMEOUT_S = 12;
const MAX_DEVICES = 4;

const DEFAULT_CONFIG = {
  lang: "auto",
  refreshMin: 5,
  show: "active", // "active": only stations in use (one fills the widget) | "all"
  alerts: { enabled: true, low: 20, critical: 10 },
  devices: [
    // sample stations (EcoFlow DELTA 2, Gendome Home 3000, BLUETTI EB3A capacities)
    { name: "EcoFlow", short: "EF", type: "demo", capacityWh: 1024, demo: { soc: 82, inW: 0, outW: 145, dsgMin: 340 } },
    { name: "Gendome", short: "GD", type: "demo", capacityWh: 3072, demo: { soc: 64, inW: 620, outW: 80, chgMin: 75 } },
    { name: "Bluetti", short: "BL", type: "demo", capacityWh: 268, demo: { soc: 18, inW: 0, outW: 120, dsgMin: 24 } },
  ],
};

class UserError extends Error {} // needs the user's action (setup, login) — cached data won't help
class LockedError extends Error {} // keychain unreadable (phone locked) — show the last rendered readings

// ───────────────────────── i18n ─────────────────────────

const I18N = {
  uk: {
    title: "Резервне живлення",
    demo: "ДЕМО",
    "state.charging": "Заряджається",
    "state.discharging": "Розряджається",
    "state.passthrough": "Транзит",
    "state.full": "Заряджено",
    "state.idle": "Очікування",
    "state.offline": "Офлайн",
    "state.error": "Помилка",
    "state.setup": "Налаштуйте",
    in: "Вхід",
    out: "Вихід",
    toFull: "до повного",
    toEmpty: "залишилось",
    load: "Навантаження",
    loadLower: "навантаження",
    stored: "Запас",
    cachedAt: "станом на {time}",
    noDevices: "Немає пристроїв",
    openScriptable: "Відкрийте скрипт у Scriptable",
    errorPrefix: "Помилка: {msg}",
    device: "Пристрій",
    "unit.W": "Вт",
    "unit.kW": "кВт",
    "unit.Wh": "Вт·год",
    "unit.kWh": "кВт·год",
    "dur.dh": "{d} дн {h} год",
    "dur.hm": "{h} год {m} хв",
    "dur.m": "{m} хв",
    "dur.long": "понад 99 год",
    "durc.m": "{m} хв",
    "durc.h": "{h} год",
    "durc.d": "{d} дн",
    "durc.long": "99+ год",
    "inline.left": "{name} {soc} · ще {time}",
    "err.network": "немає з'єднання",
    "err.noKeys": "немає ключів API",
    "err.noDevice": "не вибрано пристрій",
    "err.bluettiSession": "сесія Bluetti завершилась — увійдіть знову",
    "err.bluettiLogin": "увійдіть у Bluetti",
    "err.bluettiRejected": "Bluetti відхилив токен — увійдіть знову",
    "err.notFound": "пристрій не знайдено",
    "err.empty": "порожня відповідь",
    "err.haConfig": "вкажіть адресу й токен HA",
    "err.haToken": "HA: невірний токен",
    "err.haEntity": "HA: немає {id}",
    "err.url": "вкажіть URL",
    "err.unknownType": "невідомий тип «{type}»",
    "err.locked": "немає доступу до налаштувань — розблокуйте телефон",
    "err.lockedShort": "розблокуйте",
    "err.generic": "помилка",
    "err.state": "помилка перевірки входу — спробуйте ще раз",
    "err.noCode": "у відповіді немає коду",
    "err.efKey": "EcoFlow не прийняв ключ — перевірте Access Key",
    "err.efSign": "EcoFlow: невірний підпис — перевірте Secret Key",
    "err.efNotBound": "EcoFlow: станція не прив'язана до цього акаунта",
    "err.gendomeSession": "сесія Gendome завершилась — увійдіть знову",
    "err.gendomeLogin": "увійдіть у Gendome",
    "type.ecoflow": "EcoFlow (Open API)",
    "type.gendome": "Gendome (хмара)",
    "type.bluetti": "Bluetti (хмара, лише Wi-Fi моделі)",
    "type.homeassistant": "Home Assistant",
    "type.json": "JSON URL",
    "type.demo": "Демо-дані",
    ok: "OK",
    save: "Зберегти",
    cancel: "Скасувати",
    done: "Готово",
    back: "Назад",
    delete: "Видалити",
    "menu.title": "⚡ Резервне живлення",
    "menu.message": "Версія {v}. Пристрої з типом «Демо-дані» показують приклад — налаштуйте їх.",
    "outage.today": "Сьогодні",
    "outage.tomorrow": "Завтра",
    "outage.noData": "Графік відключень недоступний",
    "outage.off": "Світла немає за графіком",
    "outage.offUntil": "Світла немає до {time}",
    "outage.maybe": "Можливе відключення",
    "outage.maybeUntil": "Можливе відключення до {time}",
    "outage.onNoPlan": "Відключень не заплановано",
    "outage.onNoMoreToday": "Сьогодні відключень більше немає",
    "outage.header": "Відключення світла",
    "outage.ahead": "Сьогодні ще вимкнуть",
    "outage.aheadShort": "далі:",
    "outage.shortNone": "без відключень",
    "outage.shortEmergency": "аварійні",
    "outage.onNoneToday": "Сьогодні без відключень",
    "outage.offAtLeast": "Світла немає щонайменше до {time}",
    "outage.maybeAtLeast": "Можливе відключення щонайменше до {time}",
    "outage.onNext": "Відключення о {time} · через {in}",
    "outage.onMaybe": "Можливе відключення о {time} · через {in}",
    "outage.group": "черга {g}",
    "outage.emergency": "Екстрені відключення — графіки не діють",
    "outage.waiting": "Очікуємо графік",
    "outage.notYet": "ще не опубліковано",
    "outage.noGroup": "черги {g} немає в графіку",
    "menu.outage": "💡 Графік відключень: {status}",
    "outage.notSet": "не налаштовано",
    "outage.title": "Графік відключень (Київ)",
    "outage.note": "Графік береться з Yasno (ДТЕК Київські електромережі) за вашою адресою. Адреса зберігається лише на телефоні.",
    "outage.current": "{addr} · черга {g}",
    "outage.manual": "черга вказана вручну",
    "outage.setAddress": "Вказати адресу",
    "outage.changeAddress": "Змінити адресу",
    "outage.setGroup": "Вказати чергу вручну",
    "outage.test": "Перевірити зараз",
    "outage.streetTitle": "Вулиця",
    "outage.streetNote": "Щонайменше 3 літери назви, без «вул.», напр. «Хрещатик». Yasno використовує нові назви вулиць.",
    "outage.streetPh": "Назва вулиці",
    "outage.find": "Знайти",
    "outage.min3": "Потрібно щонайменше 3 літери.",
    "outage.notFound": "Нічого не знайдено",
    "outage.notFoundStreet": "Спробуйте іншу частину назви або нову назву вулиці.",
    "outage.notFoundHouse": "Спробуйте ввести номер інакше, напр. «10Б» або «10/2».",
    "outage.pickStreet": "Оберіть вулицю",
    "outage.pickHouse": "Оберіть будинок",
    "outage.houseNote": "Номер будинку, напр. 22 або 10Б.",
    "outage.housePh": "Будинок",
    "outage.noGroupFound": "Yasno не повернув чергу для цієї адреси",
    "outage.foundTitle": "Ваша черга: {g}",
    "outage.foundNote": "{addr}. Графік з'явиться у віджеті після оновлення.",
    "outage.groupTitle": "Черга відключень",
    "outage.groupNote": "Як у Yasno, напр. 20.1.",
    "outage.groupPh": "Черга",
    "outage.badGroup": "Формат черги: число або число.число, напр. 20.1.",
    "outage.provider": "Постачальник: {p}",
    "outage.providerTitle": "Чий графік показувати",
    "outage.providerNote": "Київ — Yasno (ДТЕК). Кіровоградська область — сайт Кіровоградобленерго.",
    "prov.yasno": "Київ (Yasno / ДТЕК)",
    "prov.kiroe": "Кіровоградська обл. (Кіровоградобленерго)",
    "outage.titleKiroe": "Графік відключень (Кіровоградобленерго)",
    "outage.noteKiroe": "Графік береться з kiroe.com.ua за вашою адресою. Адреса зберігається лише на телефоні.",
    "outage.groupNoteKiroe": "Як на kiroe.com.ua, напр. 3.2.",
    "outage.badGroupKiroe": "Формат черги: 1.1 … 6.2.",
    "kiroe.noToken": "kiroe.com.ua: не вдалося відкрити сторінку графіка",
    "kiroe.badResponse": "kiroe.com.ua: несподівана відповідь (можливо, перевірка Cloudflare)",
    "kiroe.pickOffice": "Підрозділ обленерго (район)",
    "kiroe.noOffices": "На сторінці kiroe.com.ua не знайшовся список районів.",
    "kiroe.cityTitle": "Населений пункт",
    "kiroe.cityNote": "Перші літери назви, напр. «Олекс».",
    "kiroe.cityPh": "Населений пункт",
    "kiroe.pickCity": "Оберіть населений пункт",
    "kiroe.streetNote": "Перші літери назви вулиці, без «вул.», напр. «Шевч».",
    "kiroe.noGroupForHouse": "kiroe.com.ua не повернув чергу для цього будинку",
    "kiroe.emptyAnswer": "kiroe.com.ua віддав порожній графік — показую останній відомий",
    "kiroe.log": "Останні відповіді сайту:",
    "menu.kiroeLog": "🩺 Журнал відповідей сайту (копіюється)",
    "kiroe.foundNote": "{addr}. Графік з'явиться у віджеті після оновлення.",
    "outage.groupOff": "відключень для черги немає",
    "menu.show": "🎯 У віджеті: {mode}",
    "show.active": "лише активні станції",
    "show.all": "усі станції",
    "show.title": "Які станції показувати у віджеті",
    "show.note": "Активні — ті, що зараз живлять навантаження або заряджаються. Якщо активна одна, вона займає весь віджет. Коли всі в очікуванні, показуються всі. Параметр віджета all завжди показує всі, 1–4 — одну вибрану.",
    "hero.stored": "Запас ≈ {v}",
    "chart.title": "Заряд за {h} год",
    "chart.now": "зараз",
    "chart.empty": "Графік заповниться за кілька оновлень",
    "live.menu": "📡 Живий режим",
    "live.title": "Живий режим",
    "live.updated": "Оновлено",
    "live.now": "щойно",
    "live.ago": "{n} с тому",
    "live.agoMin": "{n} хв тому",
    "live.sec": "{n} с",
    "live.refresh": "Оновити",
    "live.hint": "Дані оновлюються, поки цей екран відкритий. Хмари Gendome і Bluetti опитуються не частіше ніж раз на 30 с.",
    "menu.previewMedium": "👁 Перегляд: середній",
    "menu.previewSmall": "👁 Перегляд: малий",
    "menu.previewLarge": "👁 Перегляд: великий",
    "menu.previewLock": "👁 Перегляд: екран блокування",
    "menu.add": "➕ Додати пристрій",
    "menu.refresh": "⏱ Оновлення: кожні {n} хв",
    "menu.refreshTitle": "Як часто оновлювати",
    "menu.refreshNote": "iOS може оновлювати віджет рідше — це обмеження системи.",
    "menu.minutes": "{n} хв",
    "menu.diag": "🩺 Діагностика (сирі дані)",
    "menu.big": "👓 Великий шрифт: {status}",
    "big.on": "СВІТЛО Є",
    "big.off": "СВІТЛА НЕМАЄ",
    "big.maybe": "МОЖЛИВЕ ВІДКЛЮЧЕННЯ",
    "big.emergency": "АВАРІЙНІ ВІДКЛЮЧЕННЯ",
    "big.waiting": "ГРАФІКА ЩЕ НЕМАЄ",
    "big.unknown": "ГРАФІК НЕВІДОМИЙ",
    "big.until": "до {time}",
    "big.offAt": "вимкнуть о {time}",
    "big.maybeAt": "можливо вимкнуть о {time}",
    "big.noPlan": "відключень не буде",
    "big.noMoreToday": "сьогодні більше не вимкнуть",
    "big.noneToday": "сьогодні без відключень",
    "big.atLeast": "щонайменше до {time}",
    "big.emergencyNote": "графіки не діють",
    "big.left": "ще {time}",
    "big.toFull": "повна за {time}",
    "big.windows": "Сьогодні вимкнуть:",
    "big.station": "Станція",
    "big.title": "Великий шрифт",
    "big.statusOn": "увімкнено",
    "big.note": "Лише головне, великими літерами й контрастними кольорами: чи є світло і до котрої, заряд станції. Для одного віджета можна задати параметр big.",
    "menu.update": "⬇️ Оновлення скрипта: {status}",
    "update.title": "Оновлення скрипта",
    "update.note": "Вкажіть адресу, де лежить свіжа версія скрипта (напр. посилання Raw на GitHub Gist). Скрипт раз на тиждень перевірятиме її та повідомить про нову версію. Без вашого підтвердження нічого не встановлюється.",
    "update.setUrl": "Вказати адресу",
    "update.check": "Перевірити зараз",
    "update.urlNote": "Адреса файлу скрипта, починається з https://. Порожньо — вимкнути.",
    "update.badUrl": "Потрібна адреса, що починається з https://",
    "update.notScript": "За цією адресою не цей скрипт (або він завантажився не повністю).",
    "update.current": "У вас найновіша версія ({v}).",
    "update.found": "Доступна версія {v}",
    "update.foundNote": "Зараз встановлено {cur}. Налаштування та входи збережуться.",
    "update.install": "Оновити",
    "update.done": "Оновлено до {v}",
    "update.doneNote": "Закрийте скрипт і запустіть його знову. Віджети оновляться самі.",
    "update.notifyBody": "Торкніться, щоб відкрити скрипт і оновити.",
    "update.statusOn": "увімкнено",
    "menu.lang": "🌐 Мова: {lang}",
    "menu.langAuto": "Авто (як в iOS)",
    "menu.reset": "Скинути налаштування",
    "menu.resetConfirm": "Скинути все?",
    "menu.resetNote": "Ключі та входи буде видалено.",
    "menu.resetYes": "Так, скинути",
    newDevice: "Станція {n}",
    "dev.basics": "Назва та ємність",
    "dev.source": "Джерело даних: {label}",
    "dev.connect": "Підключення",
    "dev.oauthConnect": "Увійти / вибрати станцію",
    "dev.keys": "Ключі полів (розширено)",
    "dev.test": "Перевірити зараз",
    "dev.up": "Перемістити вище",
    "source.title": "Джерело даних",
    "source.note": "EcoFlow, Gendome і Bluetti з Wi-Fi — напряму через хмару. Bluetti EB3A має лише Bluetooth — підключайте через Home Assistant.",
    "basics.title": "Пристрій",
    "basics.note": "Ємність потрібна для загального запасу енергії та для оцінки часу, якщо станція його не повідомляє.",
    "basics.name": "Назва",
    "basics.short": "Коротка назва (2–3 літери)",
    "basics.capacity": "Ємність, Вт·год",
    "keys.title": "Ключі полів",
    "keys.note": "Порожнє = автоматично. Суму можна задати як A+B. Назви ключів — у «Діагностиці».",
    "field.soc": "Заряд, %",
    "field.inW": "Вхід, Вт",
    "field.outW": "Вихід, Вт",
    "field.chgMin": "До повного, хв",
    "field.dsgMin": "До розряду, хв",
    "field.remainMin": "Час (будь-який), хв",
    "ef.note": "developer-eu.ecoflow.com → увійдіть акаунтом EcoFlow → Become a Developer → після схвалення: Access Key Management → створіть Access Key і Secret Key. Станція має бути в Wi-Fi. Сервер регіону підбирається сам.",
    "ef.server": "Сервер",
    "ef.find": "Знайти пристрої",
    "setup.connectFailed": "Не вдалося підключитись",
    "setup.checkKeys": "{msg}\n\nПеревірте ключі та сервер.",
    "setup.noDevices": "Пристроїв не знайдено",
    "setup.efLinked": "Станція має бути прив'язана до того ж акаунта EcoFlow (не «поділена») і підключена до Wi-Fi.",
    "setup.blLinked": "У хмарі є лише станції з Wi-Fi. EB3A має тільки Bluetooth — підключіть її через Home Assistant.",
    "setup.gdLinked": "Станція має бути додана в застосунок Gendome цього акаунта й підключена до Wi-Fi.",
    "setup.choose": "Оберіть станцію",
    "oauth.signedIn": "Ви вже увійшли.",
    "oauth.chooseStation": "Вибрати станцію",
    "oauth.signInAgain": "Увійти знову",
    "oauth.done": "✅ Вхід виконано.<br>Закрийте це вікно.",
    "oauth.notCompleted": "Вхід не завершено",
    "oauth.safariNote": "Можна увійти через Safari: після входу скопіюйте адресу сторінки (починається з {prefix}) і вставте сюди.",
    "oauth.openSafari": "Відкрити в Safari",
    "oauth.paste": "Вставити адресу",
    "oauth.pasteTitle": "Адреса після входу",
    "oauth.pasteNote": "Починається з {prefix}?code=…",
    "oauth.safariBack": "Увійдіть у Safari, скопіюйте адресу сторінки, на яку вас переведе (починається з {prefix}), і поверніться сюди.",
    "bl.loginTitle": "Вхід у BLUETTI",
    "bl.loginNote": "Відкриється сторінка BLUETTI. Увійдіть своїм акаунтом — пароль вводиться на сайті BLUETTI, скрипт його не бачить. Після входу закрийте вікно.",
    "bl.btOnlyTitle": "Ця станція без Wi-Fi",
    "bl.btOnly": "{model} працює лише через Bluetooth, тому хмара BLUETTI не отримує її даних. Підключіть її через Home Assistant з інтеграцією bluetti_bt.",
    "bl.useHa": "Налаштувати через Home Assistant",
    "gd.loginTitle": "Вхід у Gendome",
    "gd.loginNote": "Відкриється сторінка Gendome. Увійдіть логіном і паролем акаунта Gendome (вхід через Apple ID чи WeChat там може бути недоступний). Пароль вводиться на сайті Gendome — скрипт його не бачить.",
    "ha.templateNote": "Для Bluetti EB3A (лише Bluetooth) потрібен Home Assistant з інтеграцією bluetti_bt і Bluetooth поруч зі станцією.",
    "ha.templateEb3a": "Bluetti EB3A (bluetti_bt) — знайти сенсори",
    "ha.templateManual": "Інше — вказати сенсори вручну",
    "ha.connNote": "Адреса має бути доступна з телефона через HTTPS (напр. Nabu Casa). Токен: профіль HA → Безпека → Довгострокові токени.",
    "ha.find": "Знайти сенсори",
    "ha.pickDevice": "Яка станція?",
    "ha.notFoundTitle": "Сенсорів bluetti_bt не знайдено",
    "ha.notFoundNote": "Перевірте, що інтеграція bluetti_bt додана й станція на зв'язку, або вкажіть сенсори вручну.",
    "ha.note": "Токен: профіль HA → Безпека → Довгострокові токени. Сенсори — entity_id; суму можна задати як a+b.",
    "ha.token": "Токен",
    "ha.soc": "Заряд, % (sensor.…)",
    "ha.remain": "Час, що залишився (хв/год)",
    "json.note": "Очікується JSON з полями soc, inW, outW і chgMin / dsgMin / remainMin (хвилини). Інші назви — у «Ключі полів».",
    "json.header": "Заголовок (необов'язково), напр. Authorization: Bearer …",
    "test.charge": "Заряд: {v}",
    "test.in": "Вхід: {v}",
    "test.out": "Вихід: {v}",
    "test.toFull": "До повного: {v}",
    "test.toEmpty": "Залишилось: {v}",
    "test.error": "{name}: помилка",
    "alert.lowTitle": "🔋 {name}: {soc}% — низький заряд",
    "alert.criticalTitle": "🪫 {name}: {soc}% — критичний заряд",
    "alert.left": "залишилось {time}",
    "alerts.menu": "🔔 Сповіщення: {status}",
    "alerts.off": "вимкнено",
    "alerts.title": "Сповіщення про заряд",
    "alerts.note": "Перевірка відбувається під час оновлення віджета (iOS — приблизно раз на 5–30 хв), тож віджет має бути на екрані «Додому» або блокування.",
    "alerts.enable": "Увімкнути",
    "alerts.disable": "Вимкнути",
    "alerts.thresholds": "Пороги: низький {low}%, критичний {critical}%",
    "alerts.thresholdNote": "Одне сповіщення на кожен рівень за розряд. 0 — вимкнути рівень.",
    "alerts.low": "Низький заряд, %",
    "alerts.critical": "Критичний заряд, %",
    "alerts.test": "Надіслати тестове сповіщення",
    "alerts.testTitle": "🔔 Сповіщення працюють",
    "alerts.testBody": "Повідомлю, коли заряд впаде до {low}% і до {critical}%.",
  },
  en: {
    title: "Backup power",
    demo: "DEMO",
    "state.charging": "Charging",
    "state.discharging": "Discharging",
    "state.passthrough": "Pass-through",
    "state.full": "Full",
    "state.idle": "Idle",
    "state.offline": "Offline",
    "state.error": "Error",
    "state.setup": "Set up",
    in: "In",
    out: "Out",
    toFull: "to full",
    toEmpty: "left",
    load: "Load",
    loadLower: "load",
    stored: "Stored",
    cachedAt: "as of {time}",
    noDevices: "No devices",
    openScriptable: "Open the script in Scriptable",
    errorPrefix: "Error: {msg}",
    device: "Device",
    "unit.W": "W",
    "unit.kW": "kW",
    "unit.Wh": "Wh",
    "unit.kWh": "kWh",
    "dur.dh": "{d}d {h}h",
    "dur.hm": "{h}h {m}m",
    "dur.m": "{m} min",
    "dur.long": "99+ h",
    "durc.m": "{m}m",
    "durc.h": "{h}h",
    "durc.d": "{d}d",
    "durc.long": "99+ h",
    "inline.left": "{name} {soc} · {time} left",
    "err.network": "no connection",
    "err.noKeys": "API keys missing",
    "err.noDevice": "no device selected",
    "err.bluettiSession": "Bluetti session expired — sign in again",
    "err.bluettiLogin": "sign in to Bluetti",
    "err.bluettiRejected": "Bluetti rejected the token — sign in again",
    "err.notFound": "device not found",
    "err.empty": "empty response",
    "err.haConfig": "set the HA URL and token",
    "err.haToken": "HA: invalid token",
    "err.haEntity": "HA: no entity {id}",
    "err.url": "set the URL",
    "err.unknownType": "unknown type “{type}”",
    "err.locked": "settings unavailable — unlock the phone",
    "err.lockedShort": "unlock",
    "err.generic": "error",
    "err.state": "sign-in check failed — try again",
    "err.noCode": "no code in the response",
    "err.efKey": "EcoFlow rejected the key — check the Access Key",
    "err.efSign": "EcoFlow: bad signature — check the Secret Key",
    "err.efNotBound": "EcoFlow: station isn't bound to this account",
    "err.gendomeSession": "Gendome session expired — sign in again",
    "err.gendomeLogin": "sign in to Gendome",
    "type.ecoflow": "EcoFlow (Open API)",
    "type.gendome": "Gendome (cloud)",
    "type.bluetti": "Bluetti (cloud, Wi-Fi models only)",
    "type.homeassistant": "Home Assistant",
    "type.json": "JSON URL",
    "type.demo": "Demo data",
    ok: "OK",
    save: "Save",
    cancel: "Cancel",
    done: "Done",
    back: "Back",
    delete: "Delete",
    "menu.title": "⚡ Backup power",
    "menu.message": "Version {v}. Devices of type “Demo data” show sample values — set them up.",
    "outage.today": "Today",
    "outage.tomorrow": "Tomorrow",
    "outage.noData": "Outage schedule unavailable",
    "outage.off": "No power (scheduled)",
    "outage.offUntil": "No power until {time}",
    "outage.maybe": "Possible outage",
    "outage.maybeUntil": "Possible outage until {time}",
    "outage.onNoPlan": "No outages planned",
    "outage.onNoMoreToday": "No more outages today",
    "outage.header": "Power outages",
    "outage.ahead": "Still ahead today",
    "outage.aheadShort": "next:",
    "outage.shortNone": "no outages",
    "outage.shortEmergency": "emergency",
    "outage.onNoneToday": "No outages today",
    "outage.offAtLeast": "No power until at least {time}",
    "outage.maybeAtLeast": "Possible outage until at least {time}",
    "outage.onNext": "Outage at {time} · in {in}",
    "outage.onMaybe": "Possible outage at {time} · in {in}",
    "outage.group": "queue {g}",
    "outage.emergency": "Emergency outages — schedules don't apply",
    "outage.waiting": "Waiting for the schedule",
    "outage.notYet": "not published yet",
    "outage.noGroup": "queue {g} isn't in the schedule",
    "menu.outage": "💡 Outage schedule: {status}",
    "outage.notSet": "not set",
    "outage.title": "Outage schedule (Kyiv)",
    "outage.note": "The schedule comes from Yasno (DTEK Kyiv Electric Networks) for your address. The address stays on the phone.",
    "outage.current": "{addr} · queue {g}",
    "outage.manual": "queue entered manually",
    "outage.setAddress": "Set address",
    "outage.changeAddress": "Change address",
    "outage.setGroup": "Enter queue manually",
    "outage.test": "Check now",
    "outage.streetTitle": "Street",
    "outage.streetNote": "At least 3 letters of the name, without the street type, e.g. «Хрещатик». Yasno uses the current street names.",
    "outage.streetPh": "Street name",
    "outage.find": "Find",
    "outage.min3": "At least 3 letters are needed.",
    "outage.notFound": "Nothing found",
    "outage.notFoundStreet": "Try another part of the name or the street's new name.",
    "outage.notFoundHouse": "Try writing the number differently, e.g. «10Б» or «10/2».",
    "outage.pickStreet": "Choose the street",
    "outage.pickHouse": "Choose the building",
    "outage.houseNote": "Building number, e.g. 22 or 10Б.",
    "outage.housePh": "Building",
    "outage.noGroupFound": "Yasno returned no queue for this address",
    "outage.foundTitle": "Your queue: {g}",
    "outage.foundNote": "{addr}. The schedule shows up in the widget after its next refresh.",
    "outage.groupTitle": "Outage queue",
    "outage.groupNote": "As on Yasno, e.g. 20.1.",
    "outage.groupPh": "Queue",
    "outage.badGroup": "Queue format: a number or number.number, e.g. 20.1.",
    "outage.provider": "Provider: {p}",
    "outage.providerTitle": "Whose schedule to show",
    "outage.providerNote": "Kyiv — Yasno (DTEK). Kirovohrad region — the Kirovohradoblenergo site.",
    "prov.yasno": "Kyiv (Yasno / DTEK)",
    "prov.kiroe": "Kirovohrad region (Kirovohradoblenergo)",
    "outage.titleKiroe": "Outage schedule (Kirovohradoblenergo)",
    "outage.noteKiroe": "The schedule comes from kiroe.com.ua for your address. The address stays on the phone.",
    "outage.groupNoteKiroe": "As on kiroe.com.ua, e.g. 3.2.",
    "outage.badGroupKiroe": "Queue format: 1.1 … 6.2.",
    "kiroe.noToken": "kiroe.com.ua: couldn't open the schedule page",
    "kiroe.badResponse": "kiroe.com.ua: unexpected answer (maybe a Cloudflare check)",
    "kiroe.pickOffice": "Utility office (district)",
    "kiroe.noOffices": "No district list found on kiroe.com.ua.",
    "kiroe.cityTitle": "Town / village",
    "kiroe.cityNote": "First letters of the name, e.g. «Олекс».",
    "kiroe.cityPh": "Town / village",
    "kiroe.pickCity": "Choose the town / village",
    "kiroe.streetNote": "First letters of the street name, without «вул.», e.g. «Шевч».",
    "kiroe.noGroupForHouse": "kiroe.com.ua returned no queue for this building",
    "kiroe.emptyAnswer": "kiroe.com.ua returned an empty schedule — showing the last known one",
    "kiroe.log": "Latest answers from the site:",
    "menu.kiroeLog": "🩺 Site answer log (copied)",
    "kiroe.foundNote": "{addr}. The schedule shows up in the widget after its next refresh.",
    "outage.groupOff": "no outages for this queue",
    "menu.show": "🎯 Widget shows: {mode}",
    "show.active": "active stations only",
    "show.all": "all stations",
    "show.title": "Which stations the widget shows",
    "show.note": "Active = powering a load or charging right now. A single active station fills the whole widget. When all are idle, all are shown. Widget parameter all always shows all, 1–4 picks one.",
    "hero.stored": "Stored ≈ {v}",
    "chart.title": "Charge, last {h} h",
    "chart.now": "now",
    "chart.empty": "The chart fills in after a few refreshes",
    "live.menu": "📡 Live mode",
    "live.title": "Live",
    "live.updated": "Updated",
    "live.now": "just now",
    "live.ago": "{n}s ago",
    "live.agoMin": "{n} min ago",
    "live.sec": "{n}s",
    "live.refresh": "Refresh",
    "live.hint": "Data refreshes while this screen is open. The Gendome and Bluetti clouds are polled at most every 30 s.",
    "menu.previewMedium": "👁 Preview: medium",
    "menu.previewSmall": "👁 Preview: small",
    "menu.previewLarge": "👁 Preview: large",
    "menu.previewLock": "👁 Preview: lock screen",
    "menu.add": "➕ Add device",
    "menu.refresh": "⏱ Refresh: every {n} min",
    "menu.refreshTitle": "Refresh interval",
    "menu.refreshNote": "iOS may refresh the widget less often — that's a system limit.",
    "menu.minutes": "{n} min",
    "menu.diag": "🩺 Diagnostics (raw data)",
    "menu.big": "👓 Large text: {status}",
    "big.on": "POWER ON",
    "big.off": "NO POWER",
    "big.maybe": "POSSIBLE OUTAGE",
    "big.emergency": "EMERGENCY OUTAGES",
    "big.waiting": "NO SCHEDULE YET",
    "big.unknown": "SCHEDULE UNKNOWN",
    "big.until": "until {time}",
    "big.offAt": "off at {time}",
    "big.maybeAt": "maybe off at {time}",
    "big.noPlan": "no outages planned",
    "big.noMoreToday": "no more outages today",
    "big.noneToday": "no outages today",
    "big.atLeast": "until at least {time}",
    "big.emergencyNote": "schedules don't apply",
    "big.left": "{time} left",
    "big.toFull": "full in {time}",
    "big.windows": "Outages today:",
    "big.station": "Station",
    "big.title": "Large text",
    "big.statusOn": "on",
    "big.note": "Only the essentials, in big letters and high-contrast colours: is there power and until when, the station charge. A single widget can use the parameter big.",
    "menu.update": "⬇️ Script updates: {status}",
    "update.title": "Script updates",
    "update.note": "Set the address where the latest script lives (e.g. a GitHub Gist Raw link). The script checks it once a week and tells you about a new version. Nothing is installed without your confirmation.",
    "update.setUrl": "Set address",
    "update.check": "Check now",
    "update.urlNote": "Address of the script file, starting with https://. Empty turns it off.",
    "update.badUrl": "The address must start with https://",
    "update.notScript": "That address doesn't hold this script (or the download was cut short).",
    "update.current": "You have the latest version ({v}).",
    "update.found": "Version {v} is available",
    "update.foundNote": "Installed: {cur}. Settings and sign-ins are kept.",
    "update.install": "Update",
    "update.done": "Updated to {v}",
    "update.doneNote": "Close the script and run it again. Widgets refresh on their own.",
    "update.notifyBody": "Tap to open the script and update.",
    "update.statusOn": "on",
    "menu.lang": "🌐 Language: {lang}",
    "menu.langAuto": "Auto (iOS language)",
    "menu.reset": "Reset settings",
    "menu.resetConfirm": "Reset everything?",
    "menu.resetNote": "Keys and sign-ins will be deleted.",
    "menu.resetYes": "Yes, reset",
    newDevice: "Station {n}",
    "dev.basics": "Name & capacity",
    "dev.source": "Data source: {label}",
    "dev.connect": "Connection",
    "dev.oauthConnect": "Sign in / choose station",
    "dev.keys": "Field keys (advanced)",
    "dev.test": "Test now",
    "dev.up": "Move up",
    "source.title": "Data source",
    "source.note": "EcoFlow, Gendome and Wi-Fi Bluetti models connect directly via their clouds. The Bluetti EB3A is Bluetooth-only — connect it via Home Assistant.",
    "basics.title": "Device",
    "basics.note": "Capacity is used for the total stored energy and to estimate time when the station doesn't report it.",
    "basics.name": "Name",
    "basics.short": "Short name (2–3 letters)",
    "basics.capacity": "Capacity, Wh",
    "keys.title": "Field keys",
    "keys.note": "Empty = automatic. Use A+B for a sum. Key names are listed in Diagnostics.",
    "field.soc": "Charge, %",
    "field.inW": "Input, W",
    "field.outW": "Output, W",
    "field.chgMin": "To full, min",
    "field.dsgMin": "To empty, min",
    "field.remainMin": "Time (either), min",
    "ef.note": "developer-eu.ecoflow.com → sign in with your EcoFlow account → Become a Developer → once approved: Access Key Management → create an Access Key and Secret Key. The station must be on Wi-Fi. The regional server is picked automatically.",
    "ef.server": "Server",
    "ef.find": "Find devices",
    "setup.connectFailed": "Couldn't connect",
    "setup.checkKeys": "{msg}\n\nCheck the keys and the server.",
    "setup.noDevices": "No devices found",
    "setup.efLinked": "The station must be bound to the same EcoFlow account (not shared) and be on Wi-Fi.",
    "setup.blLinked": "Only Wi-Fi stations appear in the cloud. The EB3A is Bluetooth-only — connect it via Home Assistant.",
    "setup.gdLinked": "The station must be added in the Gendome app of this account and be on Wi-Fi.",
    "setup.choose": "Choose a station",
    "oauth.signedIn": "You're already signed in.",
    "oauth.chooseStation": "Choose station",
    "oauth.signInAgain": "Sign in again",
    "oauth.done": "✅ Signed in.<br>Close this window.",
    "oauth.notCompleted": "Sign-in not completed",
    "oauth.safariNote": "You can sign in via Safari: afterwards copy the page address (it starts with {prefix}) and paste it here.",
    "oauth.openSafari": "Open in Safari",
    "oauth.paste": "Paste address",
    "oauth.pasteTitle": "Address after sign-in",
    "oauth.pasteNote": "Starts with {prefix}?code=…",
    "oauth.safariBack": "Sign in in Safari, copy the address of the page you land on (it starts with {prefix}) and come back here.",
    "bl.loginTitle": "Sign in to BLUETTI",
    "bl.loginNote": "The BLUETTI page will open. Sign in with your account — the password goes to BLUETTI's site, the script never sees it. Close the window afterwards.",
    "bl.btOnlyTitle": "This station has no Wi-Fi",
    "bl.btOnly": "The {model} is Bluetooth-only, so the BLUETTI cloud never receives its data. Connect it via Home Assistant with the bluetti_bt integration.",
    "bl.useHa": "Set up via Home Assistant",
    "gd.loginTitle": "Sign in to Gendome",
    "gd.loginNote": "The Gendome page will open. Sign in with your Gendome username and password (Apple ID / WeChat sign-in may be unavailable there). The password goes to Gendome's site — the script never sees it.",
    "ha.templateNote": "The Bluetti EB3A (Bluetooth-only) needs Home Assistant with the bluetti_bt integration and Bluetooth near the station.",
    "ha.templateEb3a": "Bluetti EB3A (bluetti_bt) — find sensors",
    "ha.templateManual": "Other — enter sensors manually",
    "ha.connNote": "The address must be reachable from the phone over HTTPS (e.g. Nabu Casa). Token: HA profile → Security → Long-lived access tokens.",
    "ha.find": "Find sensors",
    "ha.pickDevice": "Which station?",
    "ha.notFoundTitle": "No bluetti_bt sensors found",
    "ha.notFoundNote": "Check that the bluetti_bt integration is added and the station is connected, or enter the sensors manually.",
    "ha.note": "Token: HA profile → Security → Long-lived access tokens. Sensors are entity_ids; use a+b for a sum.",
    "ha.token": "Token",
    "ha.soc": "Charge, % (sensor.…)",
    "ha.remain": "Time remaining (min/h)",
    "json.note": "Expects JSON with soc, inW, outW and chgMin / dsgMin / remainMin (minutes). Other names — in Field keys.",
    "json.header": "Header (optional), e.g. Authorization: Bearer …",
    "test.charge": "Charge: {v}",
    "test.in": "Input: {v}",
    "test.out": "Output: {v}",
    "test.toFull": "To full: {v}",
    "test.toEmpty": "Remaining: {v}",
    "test.error": "{name}: error",
    "alert.lowTitle": "🔋 {name}: {soc}% — low charge",
    "alert.criticalTitle": "🪫 {name}: {soc}% — critical charge",
    "alert.left": "{time} left",
    "alerts.menu": "🔔 Alerts: {status}",
    "alerts.off": "off",
    "alerts.title": "Charge alerts",
    "alerts.note": "Checked whenever the widget refreshes (iOS: roughly every 5–30 min), so keep the widget on the Home or Lock Screen.",
    "alerts.enable": "Turn on",
    "alerts.disable": "Turn off",
    "alerts.thresholds": "Thresholds: low {low}%, critical {critical}%",
    "alerts.thresholdNote": "One alert per level per discharge. 0 disables a level.",
    "alerts.low": "Low charge, %",
    "alerts.critical": "Critical charge, %",
    "alerts.test": "Send a test notification",
    "alerts.testTitle": "🔔 Notifications work",
    "alerts.testBody": "I'll let you know when charge drops to {low}% and to {critical}%.",
  },
};
const LANG_NAMES = { uk: "Українська", en: "English" };
let LANG = "uk";

function t(key, vars) {
  let s = I18N[LANG][key] ?? I18N.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
  return s;
}

function resolveLang(pref) {
  if (I18N[pref]) return pref;
  let sys = "";
  try {
    sys = String(Device.language() || "").toLowerCase();
  } catch (_) {
    // keep default
  }
  return sys.startsWith("uk") ? "uk" : "en";
}

// #region crypto
// Pure-JS SHA-256 / HMAC-SHA256: Scriptable has no crypto API, EcoFlow signs every request.
const Crypto = (() => {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const ror = (x, n) => (x >>> n) | (x << (32 - n));

  function utf8(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function sha256(bytes) {
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const msg = bytes.concat([0x80]);
    while (msg.length % 64 !== 56) msg.push(0);
    const bits = bytes.length * 8;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    msg.push(hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    const w = new Array(64);
    for (let off = 0; off < msg.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, k] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        k = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, k].forEach((v, i) => { h[i] = (h[i] + v) | 0; });
    }
    const out = [];
    for (const v of h) out.push(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    return out;
  }

  const hex = (bytes) => bytes.map((b) => (b < 16 ? "0" : "") + b.toString(16)).join("");

  // RFC 4648 §5 base64url without padding (PKCE code_challenge)
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function base64url(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
      for (let j = 0; j < chars; j++) out += B64[(n >> (18 - 6 * j)) & 63];
    }
    return out;
  }

  function hmac(keyStr, msgStr) {
    let key = utf8(keyStr);
    if (key.length > 64) key = sha256(key);
    while (key.length < 64) key.push(0);
    const inner = sha256(key.map((b) => b ^ 0x36).concat(utf8(msgStr)));
    return sha256(key.map((b) => b ^ 0x5c).concat(inner));
  }

  return {
    sha256Hex: (s) => hex(sha256(utf8(s))),
    sha256Base64Url: (s) => base64url(sha256(utf8(s))),
    hmacSha256Hex: (key, msg) => hex(hmac(key, msg)),
  };
})();
// #endregion crypto

// ───────────────────────── helpers ─────────────────────────

async function http(url, { method = "GET", headers = {}, json = null, form = null } = {}) {
  const r = new Request(url);
  r.method = method;
  r.timeoutInterval = TIMEOUT_S;
  // build the headers completely, then assign once: Request.headers is bridged to native code, and
  // mutating the object after assignment isn't guaranteed to reach the request
  const h = Object.assign({ Accept: "application/json" }, headers);
  if (json != null) {
    h["Content-Type"] = "application/json";
    r.body = JSON.stringify(json);
  } else if (form != null) {
    h["Content-Type"] = "application/x-www-form-urlencoded";
    r.body = Object.entries(form).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  }
  r.headers = h;
  let text;
  try {
    text = await r.loadString();
  } catch (e) {
    // keep the reason: a TLS/certificate failure (e.g. self-signed HA) is not "no connection"
    throw new Error(`${t("err.network")}: ${(e && e.message) || e}`);
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    // non-JSON body — callers report the HTTP status
  }
  return { status: r.response ? r.response.statusCode : 0, data, text, cookies: (r.response && r.response.cookies) || [] };
}

function num(x) {
  if (x == null || x === "") return null;
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// First numeric value among keys; a key may be a sum "A+B". `override` (user-set) wins.
function pickNum(map, override, candidates) {
  const keys = override ? [override] : candidates;
  for (const key of keys) {
    let total = null;
    for (const part of String(key).split("+").map((s) => s.trim()).filter(Boolean)) {
      const v = num(map[part]);
      if (v != null) total = (total || 0) + v;
    }
    if (total != null) return total;
  }
  return null;
}

function flatten(obj, prefix = "", out = {}) {
  if (obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function randomString(len) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let s = "";
  for (let i = 0; i < len; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function queryParam(url, name) {
  const m = String(url).match(new RegExp(`[?&#]${name}=([^&#]*)`));
  if (!m) return null;
  let v = m[1];
  // BLUETTI may percent-encode the code twice ("%253D"); base64 never contains "%" itself.
  for (let i = 0; i < 3 && /%[0-9A-Fa-f]{2}/.test(v); i++) v = decodeURIComponent(v);
  return v;
}

const dec = (x, digits) => {
  const s = x.toFixed(digits);
  return LANG === "uk" ? s.replace(".", ",") : s;
};

function fmtDuration(min) {
  if (min == null) return "—";
  if (min >= LONG_MIN) return t("dur.long");
  const total = Math.max(1, Math.round(min));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return t("dur.dh", { d, h });
  if (h > 0) return t("dur.hm", { h, m });
  return t("dur.m", { m });
}

function fmtW(w) {
  if (w == null) return "—";
  const a = Math.abs(w);
  if (a >= 1000) return `${dec(w / 1000, a >= 10000 ? 0 : 1)} ${t("unit.kW")}`;
  return `${Math.round(w)} ${t("unit.W")}`;
}

function fmtWh(wh) {
  if (wh >= 1000) return `${dec(wh / 1000, 1)} ${t("unit.kWh")}`;
  return `${Math.round(wh)} ${t("unit.Wh")}`;
}

// "17:38" today, "27.10 17:38" otherwise — so days-old cached data never looks current
function fmtClock(ts) {
  const d = new Date(ts);
  const df = new DateFormatter();
  df.dateFormat = d.toDateString() === new Date().toDateString() ? "HH:mm" : "dd.MM HH:mm";
  return df.string(d);
}

// ───────────────────────── providers ─────────────────────────
// Each fetch(dev, ctx) returns { reading, raw }. reading fields (all optional):
//   soc %, inW, outW, chgMin (to full), dsgMin (to empty), remainMin (either), online.
// ctx.dirty = true asks the caller to persist dev (e.g. refreshed tokens).

// ── EcoFlow (official IoT Open API, HMAC-SHA256 signed) ──

// Accounts are split by region: a key only works on its region's host (api-e = Europe, api-a = Americas).
const EF_HOSTS = ["api-e.ecoflow.com", "api.ecoflow.com", "api-a.ecoflow.com"];
// DELTA 2 keys from the official Open API doc first (f32LcdShowSoc = the value the app shows); then newer
// models (cms*/pow*), DELTA Pro/Max (ems.*, bmsMaster.*) and DELTA Pro Ultra as fallbacks.
const EF_KEYS = {
  soc: [
    "bms_emsStatus.f32LcdShowSoc", "bms_emsStatus.lcdShowSoc", "pd.soc", "cmsBattSoc", "ems.f32LcdShowSoc", "ems.lcdShowSoc",
    "bms_bmsStatus.soc", "bmsMaster.soc", "bmsBattSoc", "hs_yj751_pd_appshow_addr.soc", "soc",
  ],
  inW: ["pd.wattsInSum", "powInSumW", "hs_yj751_pd_appshow_addr.wattsInSum", "inv.inputWatts", "wattsInSum", "inputWatts"],
  outW: ["pd.wattsOutSum", "powOutSumW", "hs_yj751_pd_appshow_addr.wattsOutSum", "inv.outputWatts", "wattsOutSum", "outputWatts"],
  chgMin: ["bms_emsStatus.chgRemainTime", "ems.chgRemainTime", "cmsChgRemTime", "hs_yj751_pd_appshow_addr.chgRemainTime"],
  dsgMin: ["bms_emsStatus.dsgRemainTime", "ems.dsgRemainTime", "cmsDsgRemTime", "hs_yj751_pd_appshow_addr.dsgRemainTime"],
  remainMin: ["pd.remainTime", "hs_yj751_pd_appshow_addr.remainTime", "remainTime"],
};
// Errors come back as HTTP 200 with a string code. These need the user, not a retry.
const EF_USER_ERRORS = { 8513: "err.efKey", 8521: "err.efSign", 8524: "err.efSign", 1006: "err.efNotBound" };

async function ecoflowCall(dev, host, path, params) {
  const nonce = String(100000 + Math.floor(Math.random() * 900000));
  const timestamp = String(Date.now());
  const query = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const auth = `accessKey=${dev.accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  const sign = Crypto.hmacSha256Hex(dev.secretKey, query ? `${query}&${auth}` : auth);
  return http(`https://${host}${path}${query ? `?${query}` : ""}`, { headers: { accessKey: dev.accessKey, nonce, timestamp, sign } });
}

async function ecoflowRequest(dev, path, params = {}, ctx = null) {
  if (!dev.accessKey || !dev.secretKey) throw new UserError(t("err.noKeys"));
  const host = dev.host || EF_HOSTS[0];
  let res = await ecoflowCall(dev, host, path, params);
  // 8513 ("accessKey is invalid") is also what a key gets on the other region's host — try the others once.
  // Any other answer means the host knows the key: keep it, so its real error (bad secret, unbound) shows.
  if (res.data && String(res.data.code) === "8513") {
    for (const other of EF_HOSTS.filter((h) => h !== host)) {
      const alt = await ecoflowCall(dev, other, path, params).catch(() => null);
      if (alt && alt.data && alt.data.code != null && String(alt.data.code) !== "8513") {
        dev.host = other;
        if (ctx) ctx.dirty = true;
        res = alt;
        break;
      }
    }
  }
  const d = res.data;
  if (!d) throw new Error(`EcoFlow: HTTP ${res.status}`);
  if (String(d.code) !== "0") {
    if (EF_USER_ERRORS[d.code]) throw new UserError(t(EF_USER_ERRORS[d.code]));
    throw new Error(`EcoFlow: ${d.message || t("err.generic")} (${d.code})`);
  }
  return d.data;
}

async function fetchEcoFlow(dev, ctx) {
  if (!dev.sn) throw new UserError(t("err.noDevice"));
  const [quota, list] = await Promise.all([
    ecoflowRequest(dev, "/iot-open/sign/device/quota/all", { sn: dev.sn }, ctx),
    ecoflowRequest(dev, "/iot-open/sign/device/list", {}, ctx).catch(() => null),
  ]);
  const q = flatten(quota || {});
  const item = Array.isArray(list) ? list.find((x) => x.sn === dev.sn) : null;
  const k = dev.keys || {};
  const reading = { online: item ? Number(item.online) === 1 : null };
  for (const field of Object.keys(EF_KEYS)) reading[field] = pickNum(q, k[field], EF_KEYS[field]);
  // pd.remainTime is signed (+ to full, − to empty): turn it into the side it describes so it is
  // never shown as the opposite direction
  if (reading.remainMin != null && !k.remainMin) {
    if (reading.remainMin > 0 && reading.chgMin == null) reading.chgMin = reading.remainMin;
    if (reading.remainMin < 0 && reading.dsgMin == null) reading.dsgMin = -reading.remainMin;
    reading.remainMin = null;
  }
  return { reading, raw: { device: item, quota: q } };
}

// ── Bluetti (cloud API used by the official Home Assistant integration, OAuth2) ──

const BLUETTI = {
  sso: "https://sso.bluettipower.com",
  gw: "https://gw.bluettipower.com",
  clientId: "HomeAssistant",
  clientSecret: "SG9tZUFzc2lzdGFudA==", // sent verbatim — decoding it gives invalid_secret
  redirect: "https://localhost/bluetti-callback", // never loaded: the WebView intercepts it
};

function storeTokens(dev, d) {
  const prev = dev.auth || {};
  dev.auth = {
    accessToken: d.access_token,
    refreshToken: d.refresh_token || prev.refreshToken,
    expiresAt: Date.now() + (num(d.expires_in) || 3600) * 1000,
  };
}

async function bluettiTokenRequest(form) {
  const res = await http(`${BLUETTI.sso}/oauth2/token`, {
    method: "POST",
    form: Object.assign({ client_id: BLUETTI.clientId, client_secret: BLUETTI.clientSecret }, form),
  });
  const d = res.data || {};
  if (!d.access_token) {
    if (d.error === "invalid_grant") throw new UserError(t("err.bluettiSession"));
    throw new Error(`Bluetti: ${d.error_description || d.error || `HTTP ${res.status}`}`);
  }
  return d;
}

async function bluettiToken(dev, ctx, force) {
  const a = dev.auth || {};
  if (!force && a.accessToken && Date.now() < (a.expiresAt || 0) - 30000) return a.accessToken;
  if (!a.refreshToken) throw new UserError(t("err.bluettiLogin"));
  storeTokens(dev, await bluettiTokenRequest({ grant_type: "refresh_token", refresh_token: a.refreshToken }));
  ctx.dirty = true;
  return dev.auth.accessToken;
}

async function bluettiCall(dev, ctx, path, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await bluettiToken(dev, ctx, attempt > 0);
    const res = await http(BLUETTI.gw + path, Object.assign({}, opts, { headers: { Authorization: token } }));
    const d = res.data;
    const code = d ? (typeof d.msgCode === "number" ? d.msgCode : num(d.code)) : null;
    if (res.status === 401 || res.status === 403 || code === 805) continue; // token expired → refresh once
    if (!d) throw new Error(`Bluetti: HTTP ${res.status}`);
    if (code !== 0) throw new Error(`Bluetti: ${d.msg || d.message || t("err.generic")} (${code})`);
    return d.data;
  }
  throw new UserError(t("err.bluettiRejected"));
}

// Clouds send booleans as true / 1 / "1" / "true" / "online".
const truthy = (v) => v === true || v === 1 || ["1", "true", "online"].includes(String(v).toLowerCase());

async function bluettiStates(dev, ctx) {
  const data = await bluettiCall(dev, ctx, `/api/bluiotdata/ha/v1/deviceStates?sns=${encodeURIComponent(dev.sn)}`);
  const list = Array.isArray(data) ? data : [];
  return list.find((x) => x.sn === dev.sn) || list[0] || null;
}

async function fetchBluetti(dev, ctx) {
  if (!dev.sn) throw new UserError(t("err.noDevice"));
  let item = await bluettiStates(dev, ctx);
  if (item && String(item.isBindByCurUser) === "0") {
    // an unbound device reports offline with an empty stateList until it is bound to this token
    await bluettiCall(dev, ctx, "/api/bluiotdata/ha/v1/bindDevices", { method: "POST", json: { bindSnList: [dev.sn] } });
    item = await bluettiStates(dev, ctx);
  }
  if (!item) throw new Error(`Bluetti: ${t("err.notFound")}`);
  const states = {};
  for (const s of item.stateList || []) states[s.fnCode] = s.fnValue;
  // the cloud sometimes answers 200 with no states — keep the cached reading instead of zeros
  if (!Object.keys(states).length) throw new Error(`Bluetti: ${t("err.empty")}`);
  const k = dev.keys || {};
  return {
    reading: {
      online: truthy(item.online),
      soc: pickNum(states, k.soc, ["SOC", "TotalBatterySOC", "BatterySOC"]),
      inW: pickNum(states, k.inW, ["PVAllTotalPower+GridAllTotalPower", "TotalInputPower"]),
      outW: pickNum(states, k.outW, ["ACLoadAllTotalPower+DCLoadAllTotalPower", "TotalOutputPower"]),
      chgMin: pickNum(states, k.chgMin, ["ChgFullTime"]),
      dsgMin: pickNum(states, k.dsgMin, ["DsgFullTime"]),
      remainMin: k.remainMin ? pickNum(states, k.remainMin, []) : null,
    },
    raw: { sn: item.sn, online: item.online, states },
  };
}

// ── Gendome (official cloud API behind Gendome's Home Assistant integration; OAuth2 + PKCE) ──

const GENDOME = {
  oauth: "https://oauth.gendome.cloud",
  api: "https://api.gendome.cloud/aiot-devicecenter/openapi/home-assistant",
  clientId: "gendome_home_assistant", // public client: no secret, PKCE S256 is mandatory
  redirect: "https://my.home-assistant.io/redirect/oauth", // checked exactly by the server; the WebView intercepts it
  // checked exactly too, so the integration's full scope list is sent although the widget only reads
  scope: "device:read statistics:read device:control:switch device:control:setting scheduled_charging:read scheduled_charging:write",
};

async function gendomeTokenRequest(form) {
  const res = await http(`${GENDOME.oauth}/oauth/token`, { method: "POST", form: Object.assign({ client_id: GENDOME.clientId }, form) });
  const d = res.data || {};
  if (!d.access_token) {
    if (d.error === "invalid_grant") throw new UserError(t("err.gendomeSession"));
    throw new Error(`Gendome: ${d.error_description || d.error || `HTTP ${res.status}`}`);
  }
  return d;
}

async function gendomeToken(dev, ctx, force) {
  const a = dev.auth || {};
  if (!force && a.accessToken && Date.now() < (a.expiresAt || 0) - 30000) return a.accessToken;
  if (!a.refreshToken) throw new UserError(t("err.gendomeLogin"));
  storeTokens(dev, await gendomeTokenRequest({ grant_type: "refresh_token", refresh_token: a.refreshToken }));
  ctx.dirty = true;
  return dev.auth.accessToken;
}

async function gendomeCall(dev, ctx, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await gendomeToken(dev, ctx, attempt > 0);
    const res = await http(GENDOME.api + path, { headers: { Authorization: `Bearer ${token}` } });
    const d = res.data;
    // a bad or expired token is HTTP 401 — or HTTP 200 with {success:false, code:"SYS_0011"} → refresh once
    if (res.status === 401 || res.status === 403 || (d && String(d.code) === "SYS_0011")) continue;
    if (!d) throw new Error(`Gendome: HTTP ${res.status}`);
    if (d.success === false) throw new Error(`Gendome: ${d.message || t("err.generic")} (${d.code})`);
    return d.data;
  }
  throw new UserError(t("err.gendomeLogin"));
}

async function fetchGendome(dev, ctx) {
  if (!dev.sn) throw new UserError(t("err.noDevice"));
  const data = await gendomeCall(dev, ctx, "/devices/states");
  const list = Array.isArray(data) ? data : [];
  const item = list.find((x) => String(x.deviceId) === String(dev.sn)) || (list.length === 1 ? list[0] : null);
  if (!item) throw new Error(`Gendome: ${t("err.notFound")}`);
  const s = item.states || {};
  const online = item.online ?? s.online;
  const k = dev.keys || {};
  return {
    reading: {
      online: online == null ? null : truthy(online),
      soc: pickNum(s, k.soc, ["batterySoc"]),
      inW: pickNum(s, k.inW, ["inputTotalPower"]),
      outW: pickNum(s, k.outW, ["outputTotalPower"]),
      // not "remainingTime": the cloud picks its side from input > 0, which is wrong in pass-through
      chgMin: pickNum(s, k.chgMin, ["chargeRemainingTime"]),
      dsgMin: pickNum(s, k.dsgMin, ["dischargeRemainingTime"]),
      remainMin: k.remainMin ? pickNum(s, k.remainMin, []) : null,
    },
    raw: { deviceId: item.deviceId, model: item.model, online: item.online, updateTime: item.updateTime, states: s },
  };
}

// ── Home Assistant (REST API, long-lived token) ──

function scaleUnit(v, unit) {
  switch (String(unit || "").toLowerCase()) {
    case "kw": return v * 1000;
    case "h": return v * 60;
    case "d": return v * 1440;
    case "s": return v / 60;
    default: return v; // %, W, min
  }
}

async function fetchHomeAssistant(dev) {
  const base = String(dev.url || "").replace(/\/+$/, "");
  if (!base || !dev.token) throw new UserError(t("err.haConfig"));
  const e = dev.entities || {};
  const raw = {};
  const read = async (spec) => {
    if (!spec) return null;
    let total = null;
    for (const id of String(spec).split("+").map((s) => s.trim()).filter(Boolean)) {
      const res = await http(`${base}/api/states/${id}`, { headers: { Authorization: `Bearer ${dev.token}` } });
      if (res.status === 401) throw new UserError(t("err.haToken"));
      if (res.status === 404) throw new UserError(t("err.haEntity", { id }));
      if (!res.data) throw new Error(`HA: HTTP ${res.status}`);
      raw[id] = res.data.state;
      const v = num(res.data.state);
      if (v != null) total = (total || 0) + scaleUnit(v, res.data.attributes && res.data.attributes.unit_of_measurement);
    }
    return total;
  };
  const fields = ["soc", "inW", "outW", "chgMin", "dsgMin", "remainMin"];
  const values = await Promise.all(fields.map((f) => read(e[f])));
  const reading = {};
  fields.forEach((f, i) => { reading[f] = values[i]; });
  // "unavailable"/"unknown" (e.g. the EB3A out of Bluetooth range, HA restarting) is not "idle at 0 W":
  // fail softly so the last good reading is shown as cached
  if (e.soc && reading.soc == null) {
    const id = String(e.soc).split("+")[0].trim();
    throw new Error(`HA: ${id} — ${raw[id] == null ? t("err.empty") : raw[id]}`);
  }
  reading.online = reading.soc != null ? true : null;
  return { reading, raw };
}

// ── Any JSON endpoint: {soc, inW, outW, chgMin, dsgMin, remainMin, online} or custom key paths ──

const JSON_KEYS = {
  soc: ["soc", "battery", "battery_level", "percent"],
  inW: ["inW", "input", "inputWatts", "input_w"],
  outW: ["outW", "output", "outputWatts", "output_w"],
  chgMin: ["chgMin", "charge_min"],
  dsgMin: ["dsgMin", "discharge_min"],
  remainMin: ["remainMin", "remain_min", "remaining_min"],
};

async function fetchJson(dev) {
  if (!dev.url) throw new UserError(t("err.url"));
  const headers = {};
  const h = String(dev.header || "").match(/^\s*([^:]+):\s*(.+)$/);
  if (h) headers[h[1].trim()] = h[2].trim();
  const res = await http(dev.url, { headers });
  if (res.status >= 400 || !res.data) throw new Error(`JSON: HTTP ${res.status}`);
  const f = flatten(res.data);
  const k = dev.keys || {};
  const reading = { online: f.online == null ? null : f.online === true || f.online === 1 || f.online === "1" };
  for (const field of Object.keys(JSON_KEYS)) reading[field] = pickNum(f, k[field], JSON_KEYS[field]);
  return { reading, raw: f };
}

async function fetchDemo(dev, ctx) {
  const d = Object.assign({}, dev.demo || {});
  d.online = true;
  if (ctx && ctx.live) {
    // live mode: let the sample numbers breathe a little so the demo shows what "live" looks like
    const wobble = (w) => (w ? Math.max(0, Math.round(w * (0.92 + Math.random() * 0.16))) : w);
    d.inW = wobble(d.inW);
    d.outW = wobble(d.outW);
  }
  return { reading: d, raw: d };
}

// liveMinS: the fastest the live mode polls each source. The Gendome and BLUETTI clouds refresh
// about once a minute and answer 429 to eager clients; EcoFlow and Home Assistant are near-live.
const PROVIDERS = {
  ecoflow: { fetch: fetchEcoFlow, setup: setupEcoFlow, keys: EF_KEYS, liveMinS: 5 },
  gendome: { fetch: fetchGendome, setup: setupGendome, keys: {}, oauth: true, liveMinS: 30 },
  bluetti: { fetch: fetchBluetti, setup: setupBluetti, keys: {}, oauth: true, liveMinS: 30 },
  homeassistant: { fetch: fetchHomeAssistant, setup: setupHomeAssistant, liveMinS: 3 },
  json: { fetch: fetchJson, setup: setupJson, keys: JSON_KEYS, liveMinS: 3 },
  demo: { fetch: fetchDemo, liveMinS: 1 },
};
const typeLabel = (type) => (PROVIDERS[type] ? t(`type.${type}`) : type);

// ───────────────────────── outage schedule (Kyiv, Yasno) ─────────────────────────
// The public API behind static.yasno.ua/kyiv/outages: address → group, and one JSON with every group's
// schedule for today/tomorrow (slots in minutes from Kyiv midnight). Yasno renumbers its street/house ids
// every few days, so the address is kept by name and re-resolved when an id stops working.

const YASNO = {
  base: "https://app.yasno.ua/api/blackout-service/public/shutdowns",
  regionId: 25, // Київ
  dsoId: 902, // ПРАТ «ДТЕК Київські електромережі»
};
const OUTAGE_FILE = "power-widget-outage.json";
const OUTAGE_RECHECK_MS = 24 * 3600 * 1000; // how often the group is re-resolved from the address
const SLOTS_PER_DAY = 96; // 15-minute slots
const YASNO_KIND = { Definite: "off", Possible: "maybe", Unknown: "maybe", NotPlanned: "on" };
const YASNO_STATUS = { ScheduleApplies: "schedule", NoOutages: "none", WaitingForSchedule: "waiting", EmergencyShutdowns: "emergency" };

async function yasnoAddress(path, params) {
  const q = Object.entries(Object.assign({ regionId: YASNO.regionId, dsoId: YASNO.dsoId }, params))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const res = await http(`${YASNO.base}/addresses/v2/${path}?${q}`);
  if (res.status === 404) return null; // stale street/house id
  if (!res.data) throw new Error(`Yasno: HTTP ${res.status}`); // an HTML page here is a bot challenge
  return res.data;
}

const yasnoStreets = (query) => yasnoAddress("streets", { query });
const yasnoHouses = (streetId, query) => yasnoAddress("houses", { streetId, query });

async function yasnoGroup(streetId, houseId) {
  const g = await yasnoAddress("group", { streetId, houseId });
  return g && g.group != null ? `${g.group}.${g.subgroup == null ? 0 : g.subgroup}` : null;
}

// Find street + house by exact name again (after Yasno renumbered its ids) → updated address or null.
async function yasnoResolve(o) {
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
  const streets = (await yasnoStreets(o.street.replace(/^\S+\.\s*/, ""))) || []; // search without "вул." etc.
  const street = streets.find((s) => norm(s.value) === norm(o.street));
  if (!street) return null;
  const houses = (await yasnoHouses(street.id, o.house)) || [];
  const house = houses.find((h) => norm(h.value) === norm(o.house));
  if (!house) return null;
  const group = await yasnoGroup(street.id, house.id);
  return group ? Object.assign({}, o, { streetId: street.id, houseId: house.id, group, resolvedAt: Date.now() }) : null;
}

// Yasno day → { date, status, slots } with 96 quarter-hour slots ("on" | "off" | "maybe").
function yasnoDay(day) {
  if (!day || !day.date) return null;
  const date = String(day.date).slice(0, 10); // wall-clock date: the offset can be stale around DST changes
  const status = YASNO_STATUS[day.status] || "schedule";
  if (status === "waiting" || status === "emergency") return { date, status, slots: null };
  const slots = Array.from({ length: SLOTS_PER_DAY }, (_, i) => {
    const mid = i * 15 + 7.5;
    const s = (day.slots || []).find((x) => x.start <= mid && mid < x.end);
    return s ? YASNO_KIND[s.type] || "maybe" : "on";
  });
  return { date, status, slots };
}

async function fetchYasno(cfg, ctx) {
  const o = cfg.outage;
  // re-check the group now and then: ids drift, and a building can be moved to another group
  if (o.street && o.house && Date.now() - (o.resolvedAt || 0) > OUTAGE_RECHECK_MS) {
    try {
      const group = o.streetId && o.houseId ? await yasnoGroup(o.streetId, o.houseId) : null;
      const fresh = group ? Object.assign({}, o, { group, resolvedAt: Date.now() }) : await yasnoResolve(o);
      if (fresh) {
        cfg.outage = fresh;
        ctx.dirty = true;
      }
    } catch (_) {
      // keep the known group; the schedule request below decides whether we have data
    }
  }
  const res = await http(`${YASNO.base}/regions/${YASNO.regionId}/dsos/${YASNO.dsoId}/planned-outages`);
  if (!res.data || typeof res.data !== "object") throw new Error(`Yasno: HTTP ${res.status}`);
  const g = res.data[cfg.outage.group];
  if (!g) throw new Error(t("outage.noGroup", { g: cfg.outage.group }));
  return {
    group: cfg.outage.group,
    updatedAt: g.updatedOn ? Date.parse(g.updatedOn) : Date.now(),
    fetchedAt: Date.now(),
    days: [yasnoDay(g.today), yasnoDay(g.tomorrow)].filter(Boolean),
  };
}

// ── Kirovohradoblenergo (kiroe.com.ua) ──
// The JSON API behind kiroe.com.ua/electricity-blackout (its BlackoutManager script). Every call is
// POST <base>/<endpoint>?t=<now> with form ajax=1&token=<ajaxToken>; the token is written into the page
// and belongs to the PHP session cookie the page sets, so a session = page cookies + its token.
//   /city/<officeId>   → [{ CityId, CityName, CityType }]            (offices = <select id="fn_office">)
//   /street/<cityId>   → [{ StreetId, StreetName, StreetType }]
//   /house/<streetId>  → [{ HouseId, HouseName, chergGpv, … }]
//   /actual-gpv-graphs → { "<chergGpv>": { times: { "00:00": "0", "00:30": "1", … } } }  — today only
// Answers are wrapped as { success, data }. times: "0" light on, "1" off, "10" possible outage.

const KIROE = { base: "https://kiroe.com.ua/electricity-blackout" };
const KIROE_SESSION_FILE = "power-widget-kiroe-session.json";
const KIROE_GROUP_RE = /^[1-6]\.[12]$/;
const KIROE_MIN_GAP_MS = 3 * 60 * 1000; // floor between two schedule requests (live mode, previews); widgets follow the refresh interval

const HTML_ENTITIES = { nbsp: " ", amp: "&", quot: '"', lt: "<", gt: ">", apos: "'", ndash: "–", mdash: "—", laquo: "«", raquo: "»", rsquo: "’" };
const htmlText = (s) => String(s).replace(/<[^>]+>/g, "").replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return HTML_ENTITIES[e.toLowerCase()] ?? m;
}).replace(/\s+/g, " ").trim();

// Opens the page: token, session cookies and the office list (<select id="fn_office">).
async function kiroeOpenSession() {
  const res = await http(KIROE.base, { headers: { Accept: "text/html,application/xhtml+xml" } });
  const html = res.text || "";
  const token = (html.match(/ajaxToken\s*:\s*["']([0-9a-f]{16,})["']/i) || [])[1];
  if (!token) throw new Error(res.status >= 400 ? `kiroe.com.ua: HTTP ${res.status}` : t("kiroe.noToken"));
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const offices = [];
  const sel = html.match(/<select[^>]*id\s*=\s*["']fn_office["'][^>]*>([\s\S]*?)<\/select>/i);
  if (sel) {
    for (const m of sel[1].matchAll(/<option[^>]*value\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/option>/gi)) offices.push({ id: m[1], name: htmlText(m[2]) });
  }
  const session = { token, cookie, at: Date.now() };
  writeJsonFile(KIROE_SESSION_FILE, session);
  return Object.assign({ offices }, session);
}

// One API call; a stale token/cookie (non-JSON answer, 403, success:false) gets one fresh session.
const KIROE_SESSION_MAX_MS = 15 * 60 * 1000; // PHP sessions expire (~24 min by default): renew before that
const KIROE_LOG_FILE = "power-widget-kiroe-log.json";
const isEmptyData = (x) => x == null || (typeof x === "object" && !Object.keys(x).length);

// Last answers of the site (no cookies or tokens), shown by "Перевірити зараз" to see what went wrong.
function kiroeLog(entry) {
  const log = readJsonFile(KIROE_LOG_FILE);
  const list = Array.isArray(log.list) ? log.list : [];
  list.push(Object.assign({ at: Date.now() }, entry));
  writeJsonFile(KIROE_LOG_FILE, { list: list.slice(-12) });
}

// One API call. A stale session (old, non-JSON answer, 403, success:false) gets one fresh session; with
// `needData`, so does an empty answer — an expired session can come back as {success:true, data:[]},
// which must not read as "no outages".
async function kiroeApi(endpoint, extra = {}, session = null, needData = false) {
  let s = session || readJsonFile(KIROE_SESSION_FILE);
  let empty = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!s || !s.token || attempt > 0 || Date.now() - (s.at || 0) > KIROE_SESSION_MAX_MS) s = await kiroeOpenSession();
    const headers = { "X-Requested-With": "XMLHttpRequest", Origin: "https://kiroe.com.ua", Referer: KIROE.base };
    if (s.cookie) headers.Cookie = s.cookie;
    const res = await http(`${KIROE.base}${endpoint}?t=${Date.now()}`, { method: "POST", headers, form: Object.assign({ ajax: 1, token: s.token }, extra) });
    const d = res.data;
    kiroeLog({ endpoint, attempt, status: res.status, sessionAgeS: Math.round((Date.now() - (s.at || 0)) / 1000), body: String(res.text || "").slice(0, 160) });
    if (res.status === 404 || (d && typeof d === "object" && d.success !== false)) {
      const data = res.status === 404 || d.data == null ? null : d.data;
      if (!isEmptyData(data) || !needData) return data;
      empty = true; // empty: try once more with a fresh session before believing it
      continue;
    }
    if (attempt === 1) throw new Error(d ? `kiroe.com.ua: ${d.message || d.error || t("err.generic")}` : `${t("kiroe.badResponse")} (HTTP ${res.status})`);
  }
  return null; // empty twice
}

const kiroeList = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
const kiroeCities = async (officeId, session) => kiroeList(await kiroeApi(`/city/${officeId}`, {}, session));
const kiroeStreets = async (cityId, session) => kiroeList(await kiroeApi(`/street/${cityId}`, {}, session));
const kiroeHouses = async (streetId, session) => kiroeList(await kiroeApi(`/house/${streetId}`, {}, session));

// "08:00" / "8:30" → index of the half-hour slot (0..47)
function kiroeSlotIndex(key) {
  const m = String(key).match(/^(\d{1,2}):(\d{2})/);
  if (!m || +m[1] > 23) return -1;
  return +m[1] * 2 + (+m[2] >= 30 ? 1 : 0);
}

// { times: {...} } → 48 half-hour slots, read hour by hour the way the site's renderSchedule does:
// "10" next to a definite half takes that half's value (0+10 → on, 1+10 → off); an hour with both
// halves "10" or a missing half is the site's "?" → "maybe". Unlike the site, a 0/1 split inside an
// hour is kept as it is (half an hour on, half off) instead of a "?" for the whole hour.
function kiroeDay(groupData, date) {
  const times = groupData && groupData.times;
  if (!times || typeof times !== "object") return null;
  const raw = Array(48).fill(null);
  for (const [k, v] of Object.entries(times)) {
    const i = kiroeSlotIndex(k);
    if (i >= 0) raw[i] = String(v);
  }
  if (raw.every((x) => x == null)) return null;
  const slots = [];
  for (let h = 0; h < 24; h++) {
    const a = raw[h * 2];
    const b = raw[h * 2 + 1];
    const def = (x) => x === "0" || x === "1";
    const kind = (x) => (x === "0" ? "on" : x === "1" ? "off" : "maybe");
    if (def(a) && b === "10") slots.push(kind(a), kind(a));
    else if (a === "10" && def(b)) slots.push(kind(b), kind(b));
    else slots.push(kind(a), kind(b));
  }
  return { date, status: slots.some((x) => x !== "on") ? "schedule" : "none", slots };
}

async function fetchKiroe(cfg, ctx = {}) {
  const o = cfg.outage;
  const cached = readJsonFile(OUTAGE_FILE);
  const sameSource = cached.provider === "kiroe" && cached.group === o.group;
  if (!ctx.force && sameSource && Date.now() - (cached.fetchedAt || 0) < KIROE_MIN_GAP_MS - 20000 && (cached.days || []).some((d) => d.date === dayKey(new Date()))) return cached;
  // re-check the building's queue once a day: the utility moves addresses between queues
  if (o.streetId && o.houseId && Date.now() - (o.resolvedAt || 0) > OUTAGE_RECHECK_MS) {
    try {
      const h = (await kiroeHouses(o.streetId)).find((x) => String(x.HouseId) === String(o.houseId));
      if (h && h.chergGpv) {
        cfg.outage = Object.assign({}, o, { group: String(h.chergGpv), resolvedAt: Date.now() });
        ctx.dirty = true;
      }
    } catch (_) {
      // keep the known queue
    }
  }
  const group = cfg.outage.group;
  const graphs = await kiroeApi("/actual-gpv-graphs", {}, null, true);
  const today = dayKey(new Date()); // the site shows only "Сьогодні"
  let day;
  if (isEmptyData(graphs)) {
    // empty even with a fresh session. If today's schedule we already have still has outages ahead,
    // the empty answer is more likely a hiccup than a cancellation: keep the schedule, marked as cached.
    const known = sameSource && (cached.days || []).find((d) => d.date === today);
    const outagesAhead = known && known.slots && known.slots.some((x, i) => x !== "on" && (i + 1) * (86400000 / known.slots.length) > Date.now() - dayStart(today));
    // …but not forever: an empty answer that holds for half an hour is a real "no outages"
    const emptySince = cached.emptySince || Date.now();
    if (outagesAhead && Date.now() - emptySince < 30 * 60 * 1000) {
      writeJsonFile(OUTAGE_FILE, Object.assign({}, cached, { emptySince }));
      throw new Error(t("kiroe.emptyAnswer"));
    }
    day = { date: today, status: "none", slots: Array(48).fill("on") }; // the site: "Відключень не заплановано"
  } else if (graphs[group]) {
    day = kiroeDay(graphs[group], today);
    if (!day) throw new Error(t("kiroe.badResponse"));
  } else {
    throw new Error(t("outage.noGroup", { g: group }));
  }
  return { group, updatedAt: Date.now(), fetchedAt: Date.now(), days: [day] };
}

const OUTAGE_PROVIDERS = { yasno: fetchYasno, kiroe: fetchKiroe };
const outageProvider = (o) => (o && OUTAGE_PROVIDERS[o.provider] ? o.provider : "yasno");

async function fetchOutage(cfg, ctx) {
  const provider = outageProvider(cfg.outage);
  return Object.assign(await OUTAGE_PROVIDERS[provider](cfg, ctx), { provider });
}

// Schedule for the widget, or null when not set up. Falls back to the last good one, marked stale.
async function loadOutage(cfg, ctx) {
  if (!cfg.outage || !cfg.outage.group || cfg.outage.enabled === false) return null;
  try {
    const sched = await fetchOutage(cfg, ctx);
    writeJsonFile(OUTAGE_FILE, sched);
    return sched;
  } catch (e) {
    const cached = readJsonFile(OUTAGE_FILE);
    const sameSource = cached.group === cfg.outage.group && (cached.provider || "yasno") === outageProvider(cfg.outage);
    if (sameSource && Date.now() - (cached.fetchedAt || 0) < 2 * 24 * 3600 * 1000) return Object.assign(cached, { stale: true, error: String((e && e.message) || e) });
    return { group: cfg.outage.group, days: [], error: String((e && e.message) || e) };
  }
}

// ───────────────────────── state ─────────────────────────

// Every device gets a stable random id: cache and alert state are keyed by it, and two stations read
// through one Home Assistant URL must not share them.
function ensureIds(cfg) {
  let added = false;
  for (const d of cfg.devices) {
    if (!d.id) {
      d.id = randomString(10);
      added = true;
    }
  }
  return added;
}

function loadConfig(strict) {
  let cfg = null;
  try {
    if (Keychain.contains(CONFIG_KEY)) {
      const c = JSON.parse(Keychain.get(CONFIG_KEY));
      if (c && Array.isArray(c.devices)) {
        cfg = Object.assign({ refreshMin: 5, lang: "auto", show: "active" }, c);
        cfg.alerts = Object.assign({}, DEFAULT_CONFIG.alerts, c.alerts);
        // the plain file is the newer copy of the outage settings: a locked-phone refresh may have updated the queue there
        const pub = readJsonFile(PUBLIC_FILE);
        if (pub.outage && cfg.outage && (pub.outage.resolvedAt || 0) > (cfg.outage.resolvedAt || 0) && pub.outage.houseId === cfg.outage.houseId) cfg.outage = pub.outage;
        if (ensureIds(cfg)) saveConfig(cfg);
        else if (!pub.savedAt) writePublic(cfg); // first run of this version
        return cfg;
      }
    }
  } catch (_) {
    // fall through
  }
  // A widget may run while the phone is locked and the keychain is unavailable:
  // don't silently fall back to demo data for a configured user.
  if (strict && markerFile().exists) throw new LockedError(t("err.locked"));
  cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  ensureIds(cfg);
  return cfg;
}

function writePublic(cfg) {
  writeJsonFile(PUBLIC_FILE, { savedAt: Date.now(), lang: cfg.lang, refreshMin: cfg.refreshMin, show: cfg.show, big: cfg.big, updateUrl: cfg.updateUrl || "", outage: cfg.outage || null });
}

function saveConfig(cfg) {
  writePublic(cfg);
  Keychain.set(CONFIG_KEY, JSON.stringify(cfg));
  const m = markerFile();
  m.fm.writeString(m.path, "1");
}

function markerFile() {
  const fm = FileManager.local();
  const path = fm.joinPath(fm.documentsDirectory(), CONFIG_MARKER);
  return { fm, path, exists: fm.fileExists(path) };
}

function readJsonFile(name) {
  try {
    const fm = FileManager.local();
    const path = fm.joinPath(fm.documentsDirectory(), name);
    return fm.fileExists(path) ? JSON.parse(fm.readString(path)) || {} : {};
  } catch (_) {
    return {};
  }
}

function writeJsonFile(name, data) {
  try {
    const fm = FileManager.local();
    fm.writeString(fm.joinPath(fm.documentsDirectory(), name), JSON.stringify(data));
  } catch (_) {
    // best-effort
  }
}

const readCache = () => readJsonFile(CACHE_FILE);
const writeCache = (cache) => writeJsonFile(CACHE_FILE, cache);

const deviceId = (dev) => `${dev.type}:${dev.id || dev.sn || dev.url || dev.name}`;

// "EcoFlow Delta 2" → "ED2"; a one-word name → its first two letters.
function initialsOf(name) {
  const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return (words[0] || "?").slice(0, 2).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join("").toUpperCase();
}

// Two stations must never share a label ("EC" / "EC" for two EcoFlows): try initials, else number them.
function uniqueShorts(views) {
  const groups = {};
  views.forEach((v) => (groups[v.short] = groups[v.short] || []).push(v));
  for (const [short, group] of Object.entries(groups)) {
    if (group.length < 2) continue;
    const initials = group.map((v) => initialsOf(v.name));
    const distinct = new Set(initials).size === group.length && initials.every((s) => !groups[s] || s === short);
    group.forEach((v, i) => { v.short = distinct ? initials[i] : `${short.slice(0, 2)}${i + 1}`; });
  }
  return views;
}

function baseView(dev) {
  return {
    id: deviceId(dev),
    name: dev.name || t("device"),
    short: dev.short || initialsOf(dev.name),
    demo: dev.type === "demo",
    capacityWh: num(dev.capacityWh) || 0,
    soc: null, inW: null, outW: null,
    state: "idle", minutes: null, minutesKind: null, estimated: false,
    updatedAt: Date.now(), stale: false, error: null,
  };
}

// A usable time in minutes, or null. EcoFlow's 5939/5999 "n/a" sentinels count as unknown, so the
// capacity estimate takes over instead of a fake "99+ h".
function validMin(x) {
  if (x == null || !Number.isFinite(x)) return null;
  const a = Math.abs(x);
  return a > 0 && a < LONG_MIN ? a : null;
}

function finalize(dev, r, meta = {}) {
  const v = baseView(dev);
  v.updatedAt = meta.at || Date.now();
  v.stale = Boolean(meta.stale);
  v.error = meta.error || null;
  v.soc = r.soc == null ? null : Math.max(0, Math.min(100, Math.round(r.soc)));
  v.inW = r.inW;
  v.outW = r.outW;
  const inW = r.inW || 0;
  const outW = r.outW || 0;
  const full = v.soc != null && v.soc >= 100;
  if (r.online === false) v.state = "offline";
  else if (inW - outW > IDLE_W) v.state = full ? "full" : "charging";
  else if (outW - inW > IDLE_W) v.state = "discharging";
  else if (inW > IDLE_W) v.state = full ? "full" : "passthrough";
  else v.state = "idle";

  if (v.state === "charging") {
    v.minutesKind = "toFull";
    v.minutes = validMin(r.chgMin) ?? validMin(r.remainMin);
  } else if (v.state === "discharging") {
    v.minutesKind = "toEmpty";
    v.minutes = validMin(r.dsgMin) ?? validMin(r.remainMin);
  }
  // no time from the station → estimate from capacity and net power
  const net = Math.abs(inW - outW);
  if (v.minutes == null && v.minutesKind && v.capacityWh > 0 && v.soc != null && net > IDLE_W) {
    const wh = ((v.minutesKind === "toFull" ? 100 - v.soc : v.soc) / 100) * v.capacityWh;
    // conversion losses: discharging delivers less than stored, charging needs more than stored
    v.minutes = ((v.minutesKind === "toFull" ? wh / EST_EFFICIENCY : wh * EST_EFFICIENCY) * 60) / net;
    v.estimated = true;
  }
  return v;
}

function errorView(dev, message, needsSetup) {
  const v = baseView(dev);
  v.state = needsSetup ? "setup" : "error";
  v.error = message;
  return v;
}

// One station → its view. Updates `cache` (the caller writes it); a failure falls back to the cached reading.
async function loadOne(dev, cache, ctx) {
  const provider = PROVIDERS[dev.type];
  if (!provider) return errorView(dev, t("err.unknownType", { type: dev.type }), true);
  const id = deviceId(dev);
  try {
    const { reading } = await provider.fetch(dev, ctx);
    const at = Date.now();
    if (dev.type !== "demo" && reading.soc != null) cache[id] = { reading, at };
    return finalize(dev, reading, { at });
  } catch (e) {
    const message = String((e && e.message) || e);
    const hit = cache[id];
    // a day-old reading is history, not a fallback
    if (hit && Date.now() - hit.at < CACHE_MAX_AGE_MS && !(e instanceof UserError)) {
      return finalize(dev, hit.reading, { at: hit.at, stale: true, error: message });
    }
    return errorView(dev, message, e instanceof UserError);
  }
}

async function loadAll(cfg) {
  const cache = readCache();
  const ctx = { dirty: false };
  const views = await Promise.all(cfg.devices.slice(0, MAX_DEVICES).map((dev) => loadOne(dev, cache, ctx)));
  writeCache(cache);
  if (ctx.dirty) saveConfig(cfg);
  recordHistory(views);
  return uniqueShorts(views);
}

// ───────────────────────── low-charge alerts ─────────────────────────
// Local notifications sent from widget refreshes: one per level (low, then critical) per
// discharge. Re-armed by charge actually regained (+ALERT_REARM_PCT since the alert, or back above
// the threshold) — not by one "charging" sample, which a load switching on and off would produce.

const ALERT_RANK = { low: 1, critical: 2 };

function alertBody(v) {
  const time = timeText(v);
  const flow = flowLine(v, false);
  return [stateLabel(v), time ? t("alert.left", { time }) : null, flow ? flow.text : null].filter(Boolean).join(" · ");
}

async function sendNotification(title, body, critical) {
  const n = new Notification();
  n.title = title;
  n.body = body;
  n.sound = critical ? "failure" : "default";
  n.threadIdentifier = "power-widget";
  await n.schedule();
}

async function checkAlerts(cfg, views) {
  const a = cfg.alerts || {};
  if (!a.enabled) return [];
  const low = num(a.low) || 0;
  const critical = num(a.critical) || 0;
  const rearmAbove = Math.max(low, critical) + ALERT_REARM_PCT;
  const state = readJsonFile(ALERTS_FILE);
  const due = [];
  for (const v of views) {
    // demo, cached or broken readings must not wake anybody up
    if (v.demo || v.stale || v.soc == null || isBroken(v)) continue;
    let prev = state[v.id];
    if (typeof prev === "string") prev = { level: prev, soc: null }; // state written by v1.1
    if (prev && (v.soc > rearmAbove || (prev.soc != null && v.soc >= prev.soc + ALERT_REARM_PCT))) {
      delete state[v.id];
      prev = null;
    }
    if (prev && prev.level === "critical" && v.soc > critical + ALERT_REARM_PCT) prev = state[v.id] = { level: "low", soc: prev.soc };
    if (v.state === "charging" || v.state === "full") continue; // never alert while it is filling up
    const kind = critical > 0 && v.soc <= critical ? "critical" : low > 0 && v.soc <= low ? "low" : null;
    if (!kind || (prev && ALERT_RANK[prev.level] >= ALERT_RANK[kind])) continue;
    state[v.id] = { level: kind, soc: v.soc };
    due.push({ v, kind });
  }
  writeJsonFile(ALERTS_FILE, state);
  for (const { v, kind } of due) {
    await sendNotification(t(kind === "critical" ? "alert.criticalTitle" : "alert.lowTitle", { name: v.name, soc: v.soc }), alertBody(v), kind === "critical");
  }
  return due;
}

// Combined stored energy (needs capacities) and total load across healthy stations.
function summarize(views) {
  const ok = views.filter((v) => v.state !== "error" && v.state !== "setup" && v.soc != null);
  const withCap = ok.filter((v) => v.capacityWh > 0);
  const storedWh = withCap.length ? withCap.reduce((s, v) => s + (v.soc / 100) * v.capacityWh, 0) : null;
  const loadW = ok.reduce((s, v) => s + (v.outW || 0), 0);
  return { storedWh, loadW };
}

// ───────────────────────── rendering ─────────────────────────

const COLORS = {
  bg: Color.dynamic(new Color("#FFFFFF"), new Color("#141518")),
  card: Color.dynamic(new Color("#F2F3F7"), new Color("#222328")),
  text: Color.dynamic(new Color("#16171A"), new Color("#F4F4F6")),
  sub: Color.dynamic(new Color("#6E6E76"), new Color("#9A9AA3")),
  track: new Color("#8E8E93", 0.22),
  green: new Color("#30C85E"),
  amber: new Color("#FFB000"),
  red: new Color("#FF453A"),
  blue: new Color("#0A84FF"),
  orange: new Color("#FF7A2F"),
  white: new Color("#FFFFFF"),
};

const STATES = {
  charging: { icon: "bolt.fill", color: COLORS.blue, tint: "#0A84FF" },
  discharging: { icon: "arrow.down.circle.fill", color: COLORS.orange, tint: "#FF7A2F" },
  passthrough: { icon: "arrow.left.arrow.right.circle.fill", color: COLORS.sub, tint: "#8E8E93" },
  full: { icon: "checkmark.circle.fill", color: COLORS.green, tint: "#30C85E" },
  idle: { icon: "pause.circle.fill", color: COLORS.sub, tint: "#8E8E93" },
  offline: { icon: "wifi.slash", color: COLORS.red, tint: "#FF453A" },
  error: { icon: "exclamationmark.triangle.fill", color: COLORS.red, tint: "#FF453A" },
  setup: { icon: "gearshape.fill", color: COLORS.sub, tint: "#8E8E93" },
};

const stateOf = (v) => STATES[v.state] || STATES.idle;
const stateLabel = (v) => t(`state.${v.state}`);
const isBroken = (v) => v.state === "error" || v.state === "setup";

function levelColor(soc) {
  if (soc == null) return COLORS.track;
  if (soc >= 50) return COLORS.green;
  if (soc >= 20) return COLORS.amber;
  return COLORS.red;
}

// the same palette as hex, for translucent fills
const levelHex = (soc) => (soc == null ? "#8E8E93" : soc >= 50 ? "#30C85E" : soc >= 20 ? "#FFB000" : "#FF453A");

// Approximate widget sizes (pt) from the screen width; iOS doesn't expose them to scripts.
function widgetSizes() {
  let sw = 390;
  try {
    const s = Device.screenSize();
    sw = Math.min(s.width, s.height);
  } catch (_) {
    // keep default
  }
  return { small: Math.min(170, Math.round(sw * 0.4)), wide: Math.min(364, Math.round(sw * 0.85)) };
}

function font(weight, size) {
  switch (weight) {
    case "rounded": return Font.boldRoundedSystemFont(size);
    case "roundedMedium": return Font.semiboldRoundedSystemFont(size);
    case "bold": return Font.boldSystemFont(size);
    case "semibold": return Font.semiboldSystemFont(size);
    case "medium": return Font.mediumSystemFont(size);
    default: return Font.systemFont(size);
  }
}

function addText(stack, s, size, color = COLORS.text, weight = "regular") {
  const tx = stack.addText(String(s));
  tx.font = font(weight, size);
  tx.textColor = color;
  tx.lineLimit = 1;
  tx.minimumScaleFactor = 0.6;
  return tx;
}

function addIcon(stack, name, size, color) {
  const sym = SFSymbol.named(name);
  if (!sym) return null;
  sym.applyFont(Font.semiboldSystemFont(size));
  const img = stack.addImage(sym.image);
  img.imageSize = new Size(size, size);
  img.tintColor = color;
  return img;
}

// A horizontally centred row inside a vertical stack.
function centered(parent, fill) {
  const row = parent.addStack();
  row.centerAlignContent();
  row.addSpacer();
  fill(row);
  row.addSpacer();
  return row;
}

// "76" big + "%" small, so the number reads first.
function addPercent(stack, v, size, color = COLORS.text) {
  const row = stack.addStack();
  row.bottomAlignContent();
  if (v.soc == null) {
    addText(row, "—", size, COLORS.sub, "rounded");
    return row;
  }
  addText(row, v.soc, size, color, "rounded");
  row.addSpacer(1);
  const pct = addText(row, "%", Math.round(size * 0.58), color === COLORS.white ? color : COLORS.sub, "roundedMedium");
  pct.minimumScaleFactor = 1;
  return row;
}

function newContext(w, h) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  return ctx;
}

function barImage(pct, color, w, h) {
  const ctx = newContext(w, h);
  const r = h / 2;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, w, h), r, r);
  ctx.addPath(track);
  ctx.setFillColor(COLORS.track);
  ctx.fillPath();
  if (pct > 0) {
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, 0, Math.max(h, (w * Math.min(pct, 100)) / 100), h), r, r);
    ctx.addPath(fill);
    ctx.setFillColor(color);
    ctx.fillPath();
  }
  return ctx.getImage();
}

// Lightning bolt polygon of height h centred on (cx, cy).
function boltPath(cx, cy, h) {
  const pts = [[0.6, 0.04], [0.18, 0.56], [0.46, 0.56], [0.38, 0.96], [0.82, 0.42], [0.54, 0.42]];
  const s = h / 0.92;
  const p = new Path();
  pts.forEach(([x, y], i) => {
    const q = new Point(cx + (x - 0.5) * s, cy + (y - 0.5) * s);
    if (i) p.addLine(q);
    else p.move(q);
  });
  p.closeSubpath();
  return p;
}

// Ring gauge; `badge` draws a charging bolt badge on the ring at 1:30 o'clock.
function ringImage(pct, color, size, line, opts = {}) {
  const ctx = newContext(size, size);
  const c = size / 2;
  const r = c - line / 2;
  const at = (a) => new Point(c + r * Math.sin(a), c - r * Math.cos(a));
  ctx.setLineWidth(line);
  ctx.setStrokeColor(opts.track || COLORS.track);
  ctx.strokeEllipse(new Rect(line / 2, line / 2, size - line, size - line));
  if (pct > 0) {
    const end = (Math.min(pct, 100) / 100) * 2 * Math.PI;
    const steps = Math.max(2, Math.ceil(end / (Math.PI / 90)));
    const arc = new Path();
    arc.move(at(0));
    for (let i = 1; i <= steps; i++) arc.addLine(at((end * i) / steps));
    ctx.addPath(arc);
    ctx.setStrokeColor(color);
    ctx.strokePath();
    ctx.setFillColor(color); // round caps
    for (const a of [0, end]) {
      const p = at(a);
      ctx.fillEllipse(new Rect(p.x - line / 2, p.y - line / 2, line, line));
    }
  }
  if (opts.badge) {
    const b = Math.round(size * 0.36);
    const p = at(Math.PI / 4);
    const cx = Math.min(size - b / 2, p.x);
    const cy = Math.max(b / 2, p.y);
    ctx.setFillColor(opts.badge);
    ctx.fillEllipse(new Rect(cx - b / 2, cy - b / 2, b, b));
    ctx.addPath(boltPath(cx, cy, b * 0.57));
    ctx.setFillColor(COLORS.white);
    ctx.fillPath();
  }
  return ctx.getImage();
}

function ring(parent, v, size, line, pctSize) {
  const s = parent.addStack();
  s.size = new Size(size, size);
  s.backgroundImage = ringImage(v.soc || 0, levelColor(v.soc), size, line, { badge: v.state === "charging" ? COLORS.blue : null });
  s.layoutVertically();
  s.addSpacer();
  centered(s, (row) => addPercent(row, v, pctSize));
  s.addSpacer();
  return s;
}

// No countdown for cached readings: "3 h left" from an hour-old reading would be a lie.
function timeText(v) {
  if (v.minutes == null || v.stale) return null;
  return `${v.estimated ? "≈ " : ""}${fmtDuration(v.minutes)}`;
}

// Headline for a station: time to full/empty, else its state or error.
function mainLine(v) {
  const st = stateOf(v);
  if (isBroken(v)) return { icon: st.icon, iconColor: st.color, text: v.error || stateLabel(v), color: v.state === "error" ? COLORS.red : COLORS.sub };
  if (v.stale) return { icon: "clock.fill", iconColor: COLORS.amber, text: t("cachedAt", { time: fmtClock(v.updatedAt) }), color: COLORS.amber };
  const time = timeText(v);
  if (time) return { icon: v.state === "charging" ? "bolt.fill" : "hourglass", iconColor: st.color, text: time, color: COLORS.text };
  return { icon: st.icon, iconColor: st.color, text: stateLabel(v), color: COLORS.sub };
}

// Signed flow: "+620 Вт" charging, "−145 Вт" discharging; the minor direction follows when present.
function flowLine(v, withSecondary) {
  if (isBroken(v) || v.state === "offline") return null; // the state line already says "offline"
  const inW = v.inW || 0;
  const outW = v.outW || 0;
  const plus = `+${fmtW(inW)}`;
  const minus = `−${fmtW(outW)}`;
  if (v.state === "charging") return { text: withSecondary && outW > IDLE_W ? `${plus} · ${minus}` : plus, color: COLORS.blue };
  if (v.state === "discharging") return { text: withSecondary && inW > IDLE_W ? `${minus} · ${plus}` : minus, color: COLORS.orange };
  return { text: outW > IDLE_W ? minus : fmtW(0), color: COLORS.sub };
}

function header(w, views) {
  const row = w.addStack();
  row.centerAlignContent();
  addIcon(row, "bolt.batteryblock.fill", 11, COLORS.green);
  row.addSpacer(5);
  addText(row, t("title"), 11, COLORS.sub, "semibold");
  row.addSpacer();
  if (views.some((v) => v.demo)) {
    const pill = row.addStack();
    pill.backgroundColor = new Color("#FF7A2F", 0.16);
    pill.cornerRadius = 4;
    pill.setPadding(1, 4, 1, 4);
    addText(pill, t("demo"), 8, COLORS.orange, "bold");
    row.addSpacer(5);
  }
  if (views.some((v) => v.stale)) {
    addIcon(row, "exclamationmark.triangle.fill", 10, COLORS.amber);
    row.addSpacer(3);
  }
  const fresh = views.filter((v) => !v.demo && !isBroken(v));
  const at = fresh.length ? Math.min(...fresh.map((v) => v.updatedAt)) : Date.now();
  addText(row, fmtClock(at), 11, COLORS.sub, "medium");
}

function emptyWidget(w, message) {
  w.backgroundColor = COLORS.bg;
  w.setPadding(14, 14, 14, 14);
  addIcon(w, "bolt.batteryblock.fill", 22, COLORS.sub);
  w.addSpacer(6);
  const tx = addText(w, message, 13, COLORS.text, "semibold");
  tx.lineLimit = 3;
  w.addSpacer(4);
  addText(w, t("openScriptable"), 11, COLORS.sub);
  return w;
}

function mediumWidget(w, views, opts = {}) {
  const { wide } = widgetSizes();
  const list = views.slice(0, 3);
  const gap = 6;
  const colW = Math.floor((wide - 24 - gap * (list.length - 1)) / list.length);
  const compact = Boolean(opts.footer); // make room for the outage strip
  w.setPadding(12, 12, 12, 12);
  header(w, views);
  w.addSpacer(compact ? 6 : 8);
  const row = w.addStack();
  row.spacing = gap;
  for (const v of list) {
    const col = row.addStack();
    col.layoutVertically();
    col.size = new Size(colW, 0);
    centered(col, (s) => (compact ? ring(s, v, 44, 5, 14) : ring(s, v, 54, 6, 17)));
    col.addSpacer(compact ? 4 : 6);
    centered(col, (s) => addText(s, v.name, 12, COLORS.text, "semibold"));
    col.addSpacer(2);
    const main = mainLine(v);
    centered(col, (s) => {
      addIcon(s, main.icon, 9, main.iconColor);
      s.addSpacer(3);
      addText(s, main.text, 11, main.color, "semibold");
    });
    if (compact) continue;
    col.addSpacer(1);
    const flow = flowLine(v, true);
    centered(col, (s) => addText(s, flow ? flow.text : " ", 10, flow ? flow.color : COLORS.sub, "medium"));
  }
  if (compact) {
    w.addSpacer(6);
    opts.footer(w, "medium");
  }
  return w;
}

function smallList(w, views) {
  const { small } = widgetSizes();
  const barW = small - 26;
  w.setPadding(12, 13, 12, 13);
  views.slice(0, 3).forEach((v, i) => {
    if (i) w.addSpacer(6);
    const top = w.addStack();
    top.bottomAlignContent();
    addText(top, v.name, 12, COLORS.text, "semibold");
    if (v.stale) {
      top.addSpacer(3);
      addIcon(top, "exclamationmark.triangle.fill", 9, COLORS.amber);
    }
    top.addSpacer();
    addPercent(top, v, 14);
    w.addSpacer(2);
    const bar = w.addImage(barImage(v.soc || 0, levelColor(v.soc), barW, 5));
    bar.imageSize = new Size(barW, 5);
    w.addSpacer(3);
    const bottom = w.addStack();
    bottom.centerAlignContent();
    const main = mainLine(v);
    addIcon(bottom, main.icon, 9, main.iconColor);
    bottom.addSpacer(3);
    addText(bottom, main.text, 10, main.color === COLORS.text ? COLORS.sub : main.color, "medium");
    bottom.addSpacer(4);
    bottom.addSpacer();
    const flow = flowLine(v, false);
    if (flow) addText(bottom, flow.text, 10, flow.color, "semibold");
  });
  return w;
}

function smallSingle(w, v, opts = {}) {
  w.setPadding(12, 12, 12, 12);
  const top = w.addStack();
  top.centerAlignContent();
  addText(top, v.name, 13, COLORS.text, "semibold");
  top.addSpacer();
  if (v.demo) addText(top, t("demo"), 8, COLORS.orange, "bold");
  else if (v.stale) addIcon(top, "exclamationmark.triangle.fill", 10, COLORS.amber);
  w.addSpacer(6);
  centered(w, (s) => ring(s, v, 66, 7, 20));
  w.addSpacer(6);
  const main = mainLine(v);
  centered(w, (s) => {
    addIcon(s, main.icon, 10, main.iconColor);
    s.addSpacer(3);
    addText(s, main.text, 13, main.color, "semibold");
  });
  w.addSpacer(1);
  // the small widget has one line to spare: when the light goes off / comes back matters more than watts
  const short = opts.outage ? outageShort(opts.outage) : null;
  if (short) {
    centered(w, (s) => {
      addIcon(s, short.icon, 10, short.color);
      s.addSpacer(3);
      addText(s, short.text, 11, COLORS.sub, "semibold");
    });
    return w;
  }
  const flow = flowLine(v, true);
  centered(w, (s) => addText(s, flow ? flow.text : " ", 11, flow ? flow.color : COLORS.sub, "medium"));
  return w;
}

function chip(parent, v) {
  const st = stateOf(v);
  const c = parent.addStack();
  c.centerAlignContent();
  c.backgroundColor = new Color(v.stale ? "#FFB000" : st.tint, 0.16);
  c.cornerRadius = 6;
  c.setPadding(2, 6, 2, 6);
  addIcon(c, v.stale ? "clock.fill" : st.icon, 9, v.stale ? COLORS.amber : st.color);
  c.addSpacer(3);
  addText(c, v.stale ? t("cachedAt", { time: fmtClock(v.updatedAt) }) : stateLabel(v), 10, v.stale ? COLORS.amber : st.color, "semibold");
  return c;
}

function summaryRow(w, sum) {
  const row = w.addStack();
  row.centerAlignContent();
  if (sum.storedWh != null) {
    addIcon(row, "battery.100", 11, COLORS.green);
    row.addSpacer(4);
    addText(row, t("stored"), 11, COLORS.sub, "medium");
    row.addSpacer(3);
    addText(row, fmtWh(sum.storedWh), 11, COLORS.text, "semibold");
    row.addSpacer();
  }
  addIcon(row, "powerplug.fill", 11, COLORS.orange);
  row.addSpacer(4);
  addText(row, t("load"), 11, COLORS.sub, "medium");
  row.addSpacer(3);
  addText(row, fmtW(sum.loadW), 11, COLORS.text, "semibold");
  if (sum.storedWh == null) row.addSpacer();
}

function largeWidget(w, views, opts = {}) {
  const list = views.slice(0, MAX_DEVICES);
  const compact = list.length > 3 || Boolean(opts.footer);
  w.setPadding(14, 12, 14, 12);
  header(w, views);
  w.addSpacer(6);
  summaryRow(w, summarize(list));
  w.addSpacer(8);
  list.forEach((v, i) => {
    if (i) w.addSpacer(compact ? 5 : 7);
    const card = w.addStack();
    card.centerAlignContent();
    card.backgroundColor = COLORS.card;
    card.cornerRadius = 16;
    card.setPadding(compact ? 7 : 10, 10, compact ? 7 : 10, 12);
    ring(card, v, compact ? 42 : 52, compact ? 5 : 6, compact ? 13 : 15);
    card.addSpacer(12);
    const info = card.addStack();
    info.layoutVertically();

    const top = info.addStack();
    top.centerAlignContent();
    addText(top, v.name, 15, COLORS.text, "semibold");
    top.addSpacer(6);
    chip(top, v);
    top.addSpacer();
    info.addSpacer(compact ? 1 : 3);

    if (isBroken(v)) {
      const tx = addText(info, v.error || stateLabel(v), 12, v.state === "error" ? COLORS.red : COLORS.sub, "medium");
      tx.lineLimit = 2;
      return;
    }
    const mid = info.addStack();
    mid.bottomAlignContent();
    const time = timeText(v);
    if (time) {
      addText(mid, time, compact ? 15 : 18, COLORS.text, "bold");
      mid.addSpacer(5);
      addText(mid, v.minutesKind === "toFull" ? t("toFull") : t("toEmpty"), 11, COLORS.sub, "medium");
    } else {
      addText(mid, fmtW(v.outW || 0), compact ? 15 : 18, COLORS.text, "bold");
      mid.addSpacer(5);
      addText(mid, t("loadLower"), 11, COLORS.sub, "medium");
    }
    mid.addSpacer();
    if (compact) {
      const flow = flowLine(v, false);
      if (flow) addText(mid, flow.text, 11, flow.color, "semibold");
      return;
    }
    info.addSpacer(2);
    const flows = info.addStack();
    flows.centerAlignContent();
    addIcon(flows, "arrow.down.to.line.compact", 9, COLORS.blue);
    flows.addSpacer(3);
    addText(flows, `${t("in")} ${fmtW(v.inW)}`, 11, COLORS.sub, "medium");
    flows.addSpacer(10);
    addIcon(flows, "arrow.up.to.line.compact", 9, COLORS.orange);
    flows.addSpacer(3);
    addText(flows, `${t("out")} ${fmtW(v.outW)}`, 11, COLORS.sub, "medium");
  });
  if (opts.footer) {
    w.addSpacer();
    opts.footer(w, "large");
  }
  return w;
}

// ── One station fills the widget (the only active one, or the one picked by the parameter) ──

// "In use": powering a load (discharging, pass-through, full on grid with a load) or charging.
function isActive(v) {
  if (isBroken(v) || v.state === "offline") return false;
  return ["discharging", "charging", "passthrough"].includes(v.state) || (v.state === "full" && (v.outW || 0) > IDLE_W);
}

// Active stations, the one that runs out first in front.
function activeViews(views) {
  const order = { discharging: 0, passthrough: 1, full: 1, charging: 2 };
  return views.filter(isActive).sort((a, b) => order[a.state] - order[b.state] ||
    (a.minutes != null && b.minutes != null && a.state === "discharging" ? a.minutes - b.minutes : 0));
}

const storedOf = (v) => (v.capacityWh > 0 && v.soc != null ? (v.soc / 100) * v.capacityWh : null);

function heroHeader(w, v) {
  const row = w.addStack();
  row.centerAlignContent();
  addIcon(row, "bolt.batteryblock.fill", 12, COLORS.green);
  row.addSpacer(5);
  addText(row, v.name, 13, COLORS.text, "semibold");
  row.addSpacer(6);
  chip(row, v);
  row.addSpacer();
  if (v.demo) addText(row, t("demo"), 8, COLORS.orange, "bold");
  else if (!v.stale) addText(row, fmtClock(v.updatedAt), 11, COLORS.sub, "medium"); // the chip already dates cached data
}

// Big time (or the load when there is no time), with what it means underneath.
function heroHeadline(parent, v, size) {
  if (isBroken(v)) {
    const tx = addText(parent, v.error || stateLabel(v), 13, v.state === "error" ? COLORS.red : COLORS.sub, "medium");
    tx.lineLimit = 2;
    return;
  }
  const time = timeText(v);
  addText(parent, time || fmtW(v.outW || 0), size, COLORS.text, "bold");
  addText(parent, time ? (v.minutesKind === "toFull" ? t("toFull") : t("toEmpty")) : t("loadLower"), 12, COLORS.sub, "medium");
}

function heroFlows(parent, v, size) {
  const row = parent.addStack();
  row.centerAlignContent();
  for (const [label, value, icon, color, gap] of [[t("in"), v.inW, "arrow.down.to.line.compact", COLORS.blue, 12], [t("out"), v.outW, "arrow.up.to.line.compact", COLORS.orange, 0]]) {
    addIcon(row, icon, size - 2, color);
    row.addSpacer(3);
    addText(row, label, size, COLORS.sub, "medium");
    row.addSpacer(3);
    addText(row, fmtW(value), size, COLORS.text, "semibold");
    if (gap) row.addSpacer(gap);
  }
  return row;
}

function mediumHero(w, v, opts = {}) {
  w.setPadding(12, 14, 12, 14);
  heroHeader(w, v);
  w.addSpacer(8);
  const row = w.addStack();
  row.centerAlignContent();
  ring(row, v, 76, 8, 22);
  row.addSpacer(14);
  const info = row.addStack();
  info.layoutVertically();
  heroHeadline(info, v, 24);
  if (!isBroken(v)) {
    info.addSpacer(6);
    heroFlows(info, v, 11);
    const stored = storedOf(v);
    if (stored != null) {
      info.addSpacer(3);
      addText(info, t("hero.stored", { v: fmtWh(stored) }), 11, COLORS.sub, "medium");
    }
  }
  row.addSpacer();
  if (opts.footer) {
    w.addSpacer();
    opts.footer(w, "medium");
  }
  return w;
}

// ── Power-outage schedule strip (bottom of the widgets) ──
// Normalized schedule: { group: "20.1", updatedAt, stale?, error?, days: [{ date: "YYYY-MM-DD",
// status: "schedule" | "none" | "waiting" | "emergency", slots: N × ("on" | "off" | "maybe") | null }] }
// — equal slots over the local day (Yasno: 96 × 15 min). Sources map their own formats onto this.

const OUTAGE_HEX = { off: "#FF453A", maybe: "#FFB000", on: "#30C85E" };

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function dayStart(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

// Merged blocks [{ start, end, kind }] over every known day.
function outageBlocks(sched) {
  const blocks = [];
  for (const day of (sched && sched.days) || []) {
    if (!day.slots || !day.slots.length) continue;
    const t0 = dayStart(day.date);
    const slotMs = 86400000 / day.slots.length;
    day.slots.forEach((kind, i) => {
      const start = t0 + i * slotMs;
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind && Math.abs(last.end - start) < 1000) last.end = start + slotMs;
      else blocks.push({ start, end: start + slotMs, kind });
    });
  }
  return blocks;
}

// What's happening now and what changes next.
function outageStatus(sched, now = Date.now()) {
  const days = (sched && sched.days) || [];
  const today = days.find((d) => d.date === dayKey(new Date(now)));
  if (today && today.status === "emergency") return { kind: "emergency" };
  const blocks = outageBlocks(sched);
  const cur = blocks.find((b) => b.start <= now && now < b.end);
  if (!cur) return today && today.status === "waiting" ? { kind: "waiting" } : null;
  const isOff = (k) => k !== "on";
  const knownUntil = blocks[blocks.length - 1].end; // the schedule says nothing past this moment
  if (isOff(cur.kind)) {
    // the outage (definite or possible) lasts until the first "on" block
    const back = blocks.find((b) => b.start >= cur.end && b.kind === "on");
    // no "on" block ahead: the outage runs to the edge of what is published (e.g. midnight) — "at least until"
    return { kind: cur.kind, until: back ? back.start : null, atLeast: back ? null : knownUntil };
  }
  const next = blocks.find((b) => b.start >= cur.end && isOff(b.kind));
  if (next) return { kind: "on", next: { start: next.start, end: next.end, kind: next.kind } };
  // nothing more in what is published. Tomorrow known → "no outages"; otherwise only today is covered.
  const tomorrowKnown = knownUntil - dayStart(dayKey(new Date(now))) > 86400000 + 1000;
  const hadToday = today && today.slots && today.slots.some(isOff);
  return { kind: "on", next: null, todayOnly: !tomorrowKnown, hadToday: Boolean(hadToday) };
}

// "18:00", "завтра 06:00"
function fmtWhen(ts) {
  const d = new Date(ts);
  const tomorrow = dayKey(d) !== dayKey(new Date());
  return `${tomorrow ? `${t("outage.tomorrow").toLowerCase()} ` : ""}${fmtClock(ts).replace(/^\d\d\.\d\d /, "")}`;
}

// The edge of the published schedule is midnight: "24:00" reads better than "завтра 00:00".
function fmtEdge(ts) {
  const d = new Date(ts);
  return d.getHours() === 0 && d.getMinutes() === 0 ? "24:00" : fmtWhen(ts);
}

// Light is on and nothing more is published: say only what the schedule really covers.
const noMoreKey = (st) => (!st.todayOnly ? "outage.onNoPlan" : st.hadToday ? "outage.onNoMoreToday" : "outage.onNoneToday");

function outageLine(sched, now = Date.now()) {
  const st = outageStatus(sched, now);
  if (!st) return { icon: "lightbulb", color: COLORS.sub, text: (sched && sched.error) || t("outage.noData") };
  if (st.kind === "emergency") return { icon: "exclamationmark.triangle.fill", color: COLORS.red, text: t("outage.emergency") };
  if (st.kind === "waiting") return { icon: "clock", color: COLORS.sub, text: t("outage.waiting") };
  const until = st.until ? fmtWhen(st.until) : st.atLeast ? fmtEdge(st.atLeast) : null;
  const key = (base) => (st.until ? `${base}Until` : st.atLeast ? `${base}AtLeast` : base);
  if (st.kind === "off") return { icon: "lightbulb.slash.fill", color: COLORS.red, text: t(key("outage.off"), { time: until }) };
  if (st.kind === "maybe") return { icon: "lightbulb.slash", color: COLORS.amber, text: t(key("outage.maybe"), { time: until }) };
  if (!st.next) return { icon: "lightbulb.fill", color: COLORS.green, text: t(noMoreKey(st)) };
  return {
    icon: "lightbulb.fill",
    color: COLORS.green,
    text: t(st.next.kind === "off" ? "outage.onNext" : "outage.onMaybe", { time: fmtWhen(st.next.start), in: fmtDuration((st.next.start - now) / 60000) }),
  };
}

// One day as a bar of blocks; `nowFrac` (0..1) draws the current-time marker.
function outageBarImage(slots, w, h, nowFrac, markerW = 2) {
  const ctx = newContext(w, h);
  const sw = w / slots.length;
  let i = 0;
  while (i < slots.length) {
    let j = i;
    while (j + 1 < slots.length && slots[j + 1] === slots[i]) j++;
    const r = Math.min(3, h / 2);
    const p = new Path();
    p.addRoundedRect(new Rect(i * sw + 0.5, 0, (j - i + 1) * sw - 1, h), r, r);
    ctx.addPath(p);
    ctx.setFillColor(new Color(OUTAGE_HEX[slots[i]] || "#8E8E93", slots[i] === "on" ? 0.32 : 0.85));
    ctx.fillPath();
    i = j + 1;
  }
  if (nowFrac != null) {
    ctx.setFillColor(new Color("#0A84FF"));
    ctx.fillRect(new Rect(Math.max(0, Math.min(w - markerW, nowFrac * w - markerW / 2)), 0, markerW, h));
  }
  return ctx.getImage();
}

// Today only: tomorrow's bar would be the first thing to go stale, and tomorrow it is "today" anyway.
// size "s": one line + thin bar (medium widgets); "m": + hour ticks (large list);
// "l": the large one-station widget — big status line, thick bar, ticks and the outages still ahead.
function outageFooter(w, sched, width, size = "s") {
  const now = Date.now();
  const line = outageLine(sched, now);
  const big = size === "l";
  const head = w.addStack();
  head.centerAlignContent();
  addIcon(head, line.icon, big ? 20 : 10, line.color);
  head.addSpacer(big ? 8 : 4);
  const [headline, detail] = big ? line.text.split(" · ") : [line.text];
  const hl = addText(head, headline, big ? 22 : 11, COLORS.text, big ? "bold" : "semibold");
  if (big) hl.minimumScaleFactor = 0.75;
  head.addSpacer();
  if (sched && sched.stale) {
    addIcon(head, "clock.fill", 9, COLORS.amber);
    head.addSpacer(3);
    addText(head, fmtClock(sched.fetchedAt), 10, COLORS.amber, "medium"); // last good copy, no network now
    head.addSpacer(6);
  }
  if (sched && sched.group) addText(head, t("outage.group", { g: sched.group }), 10, COLORS.sub, "medium");
  const todayKey = dayKey(new Date(now));
  const day = ((sched && sched.days) || []).find((d) => d.date === todayKey);
  if (big) {
    // second line: "через 2 год 40 хв" and/or what is still ahead today
    const wins = outageWindows(sched, todayKey, now, true) || [];
    const parts = [detail, wins.length ? `${t("outage.aheadShort")} ${wins.join(", ")}` : null].filter(Boolean);
    if (parts.length) {
      w.addSpacer(3);
      const tx = addText(w, parts.join(" · "), 15, COLORS.sub, "medium");
      tx.minimumScaleFactor = 0.7;
    }
  }
  if (!day || !day.slots) return; // the status line already says why (emergency, waiting, no data)
  w.addSpacer(big ? 10 : 3);
  const bh = big ? 20 : size === "m" ? 10 : 8;
  const img = w.addImage(outageBarImage(day.slots, width, bh, (now - dayStart(day.date)) / 86400000, big ? 3 : 2));
  img.imageSize = new Size(width, bh);
  if (size !== "s") {
    w.addSpacer(2);
    hourTicks(w, width, big ? 11 : 9, COLORS.sub, "medium");
  }
}

// "0 6 12 18 24" spread under a day bar of the given width.
function hourTicks(parent, width, size, color, weight) {
  const ticks = parent.addStack();
  ticks.size = new Size(width, 0);
  const cell = (label, cw, align) => {
    const c = ticks.addStack();
    c.size = new Size(cw, 0);
    if (align !== "left") c.addSpacer();
    const tx = addText(c, label, size, color, weight);
    tx.minimumScaleFactor = 1;
    if (align !== "right") c.addSpacer();
  };
  const q = width / 4;
  cell("0", q / 2, "left");
  ["6", "12", "18"].forEach((l) => cell(l, q, "center"));
  cell("24", q / 2, "right");
}

// The shortest useful answer: lit bulb "до 16:00" = light until then; crossed bulb "до 14:00" = dark until then.
function outageShort(sched, now = Date.now()) {
  const st = outageStatus(sched, now);
  if (!st || st.kind === "waiting") return null;
  if (st.kind === "emergency") return { icon: "exclamationmark.triangle.fill", color: COLORS.red, text: t("outage.shortEmergency") };
  if (st.kind === "on") {
    return { icon: "lightbulb.fill", color: COLORS.green, text: st.next ? t("big.until", { time: fmtWhen(st.next.start) }) : t("outage.shortNone") };
  }
  const time = st.until ? fmtWhen(st.until) : st.atLeast ? fmtEdge(st.atLeast) : null;
  return { icon: st.kind === "off" ? "lightbulb.slash.fill" : "lightbulb.slash", color: st.kind === "off" ? COLORS.red : COLORS.amber, text: time ? t("big.until", { time }) : t(`outage.${st.kind}`) };
}

// Outage windows of one day that haven't ended yet: ["16:00–18:00", "18:30–22:00 ?"].
function outageWindows(sched, key, now = Date.now(), futureOnly = false) {
  const day = ((sched && sched.days) || []).find((d) => d.date === key);
  if (!day || !day.slots) return null;
  const t0 = dayStart(key);
  const hm = (ts) => (ts - t0 >= 86400000 - 1000 ? "24:00" : fmtClock(ts).replace(/^\d\d\.\d\d /, ""));
  const merged = [];
  for (const b of outageBlocks({ days: [day] }).filter((x) => x.kind !== "on")) {
    const last = merged[merged.length - 1];
    if (last && last.kind === b.kind && Math.abs(last.end - b.start) < 1000) last.end = b.end;
    else merged.push(Object.assign({}, b));
  }
  return merged.filter((b) => (futureOnly ? b.start > now : b.end > now)).map((b) => `${hm(b.start)}–${hm(b.end)}${b.kind === "maybe" ? " ?" : ""}`);
}

// ── No stations, only the schedule: the whole widget is about the light ──
function outageOnlyWidget(w, sched, family) {
  const { small, wide } = widgetSizes();
  const now = Date.now();
  const line = outageLine(sched, now);
  const todayKey = dayKey(new Date(now));
  const isSmall = family === "small";
  const large = family === "large" || family === "extraLarge";
  const inner = (isSmall ? small : wide) - 28;
  w.setPadding(14, 14, 14, 14);
  const head = w.addStack();
  head.centerAlignContent();
  addIcon(head, "bolt.fill", 11, COLORS.amber);
  head.addSpacer(5);
  addText(head, isSmall ? t("outage.group", { g: sched.group }) : t("outage.header"), 11, COLORS.sub, "semibold");
  head.addSpacer();
  if (!isSmall) addText(head, t("outage.group", { g: sched.group }), 11, COLORS.sub, "medium");
  w.addSpacer(isSmall ? 8 : 10);
  const row = w.addStack();
  row.centerAlignContent();
  if (!isSmall) {
    const badge = row.addStack();
    badge.size = new Size(large ? 46 : 40, large ? 46 : 40);
    badge.cornerRadius = large ? 23 : 20;
    badge.backgroundColor = new Color(line.color === COLORS.sub ? "#8E8E93" : line.color.hex, 0.16);
    badge.centerAlignContent();
    badge.addSpacer();
    addIcon(badge, line.icon, large ? 22 : 19, line.color);
    badge.addSpacer();
    row.addSpacer(12);
  }
  const col = row.addStack();
  col.layoutVertically();
  if (isSmall) col.size = new Size(inner, 0); // lets the headline wrap
  // "Відключення о 18:00 · через 4 год" → headline + detail on separate lines
  const [headline, detail] = line.text.split(" · ");
  if (isSmall) {
    addIcon(col, line.icon, 20, line.color);
    col.addSpacer(4);
  }
  const hl = addText(col, headline, isSmall ? 16 : large ? 22 : 19, COLORS.text, "bold");
  hl.lineLimit = isSmall ? 3 : 2;
  hl.minimumScaleFactor = 0.7;
  if (detail) addText(col, detail, isSmall ? 12 : 13, COLORS.sub, "medium");
  row.addSpacer();
  if (large) {
    // the outages still ahead today, one per row
    const wins = outageWindows(sched, todayKey, now, true) || [];
    if (wins.length) {
      w.addSpacer(14);
      addText(w, t("outage.ahead"), 11, COLORS.sub, "semibold");
      for (const win of wins.slice(0, 5)) {
        w.addSpacer(5);
        const wr = w.addStack();
        wr.centerAlignContent();
        const dot = wr.addStack();
        dot.size = new Size(8, 8);
        dot.cornerRadius = 4;
        dot.backgroundColor = win.endsWith("?") ? COLORS.amber : COLORS.red;
        wr.addSpacer(8);
        addText(wr, win.replace("–", " – "), 17, COLORS.text, "semibold");
        wr.addSpacer();
      }
    }
  }
  w.addSpacer();
  if (sched.stale) {
    addText(w, t("cachedAt", { time: fmtClock(sched.fetchedAt) }), 10, COLORS.amber, "medium");
    w.addSpacer(3);
  }
  const days = (sched.days || []).filter((d) => d.date === todayKey && d.slots);
  days.forEach((day) => {
    const isToday = true;
    const bh = isSmall ? 10 : 14;
    const img = w.addImage(outageBarImage(day.slots, inner, bh, isToday ? (now - dayStart(day.date)) / 86400000 : null, 3));
    img.imageSize = new Size(inner, bh);
    if (!isSmall) {
      w.addSpacer(3);
      hourTicks(w, inner, 10, COLORS.sub, "medium");
    }
  });
  return w;
}

// Refresh the widget right when the light is due to go off or come back (if that's sooner).
function outageNextChange(sched, now = Date.now()) {
  const st = outageStatus(sched, now);
  if (!st) return null;
  if (st.until || st.atLeast) return st.until || st.atLeast;
  return st.next ? st.next.start : null;
}

// ── Charge history (recorded on every refresh, shown as a chart in the large one-station widget) ──

const HISTORY_FILE = "power-widget-history.json";
const HISTORY_GAP_MS = 5 * 60 * 1000;
const CHART_HOURS = 6;

function recordHistory(views) {
  const hist = readJsonFile(HISTORY_FILE);
  const now = Date.now();
  for (const v of views) {
    if (v.demo || v.stale || v.soc == null || isBroken(v)) continue;
    const list = (hist[v.id] = hist[v.id] || []);
    const last = list[list.length - 1];
    if (last && v.updatedAt - last[0] < HISTORY_GAP_MS) continue;
    list.push([v.updatedAt, v.soc, Math.round(v.inW || 0), Math.round(v.outW || 0)]);
  }
  for (const id of Object.keys(hist)) hist[id] = hist[id].filter((p) => now - p[0] < 24 * 3600 * 1000).slice(-400);
  writeJsonFile(HISTORY_FILE, hist);
  return hist;
}

// [{t, soc}] for the chart window. Demo stations get a plausible synthetic past.
function historyPoints(v, history) {
  const now = Date.now();
  const from = now - CHART_HOURS * 3600 * 1000;
  if (v.demo) {
    const perHour = v.capacityWh > 0 ? (((v.outW || 0) - (v.inW || 0)) / v.capacityWh) * 100 : 0;
    const pts = [];
    for (let m = CHART_HOURS * 60; m >= 0; m -= 15) {
      const soc = v.soc + perHour * (m / 60) + Math.sin(m / 23) * 1.5;
      pts.push({ t: now - m * 60000, soc: Math.max(0, Math.min(100, soc)) });
    }
    return pts;
  }
  const pts = ((history || {})[v.id] || []).filter((p) => p[0] >= from).map((p) => ({ t: p[0], soc: p[1] }));
  if (!v.stale && v.soc != null && (!pts.length || pts[pts.length - 1].t < v.updatedAt)) pts.push({ t: v.updatedAt, soc: v.soc });
  return pts;
}

function chartImage(pts, w, h, soc) {
  const ctx = newContext(w, h);
  const t1 = Date.now();
  const t0 = t1 - CHART_HOURS * 3600 * 1000;
  const x = (t) => 2 + ((Math.max(t0, t) - t0) / (t1 - t0)) * (w - 4);
  const y = (s) => h - 2 - (Math.max(0, Math.min(100, s)) / 100) * (h - 4);
  ctx.setFillColor(COLORS.track); // 0 / 50 / 100 % guides
  for (const g of [0, 50, 100]) ctx.fillRect(new Rect(0, Math.round(y(g)), w, 1));
  const area = new Path();
  area.move(new Point(x(pts[0].t), h));
  pts.forEach((p) => area.addLine(new Point(x(p.t), y(p.soc))));
  area.addLine(new Point(x(pts[pts.length - 1].t), h));
  area.closeSubpath();
  ctx.addPath(area);
  ctx.setFillColor(new Color(levelHex(soc), 0.18));
  ctx.fillPath();
  const line = new Path();
  pts.forEach((p, i) => (i ? line.addLine(new Point(x(p.t), y(p.soc))) : line.move(new Point(x(p.t), y(p.soc)))));
  ctx.addPath(line);
  ctx.setStrokeColor(levelColor(soc));
  ctx.setLineWidth(2);
  ctx.strokePath();
  const last = pts[pts.length - 1];
  ctx.setFillColor(levelColor(soc));
  ctx.fillEllipse(new Rect(x(last.t) - 3, y(last.soc) - 3, 6, 6));
  return ctx.getImage();
}

function chartCard(w, v, history, width, chartH) {
  const card = w.addStack();
  card.layoutVertically();
  card.backgroundColor = COLORS.card;
  card.cornerRadius = 12;
  card.setPadding(8, 10, 6, 10);
  const head = card.addStack();
  addText(head, t("chart.title", { h: CHART_HOURS }), 10, COLORS.sub, "semibold");
  head.addSpacer();
  card.addSpacer(4);
  const pts = historyPoints(v, history);
  if (pts.length < 2) {
    addText(card, t("chart.empty"), 11, COLORS.sub);
    return card;
  }
  const cw = width - 20;
  const img = card.addImage(chartImage(pts, cw, chartH, v.soc));
  img.imageSize = new Size(cw, chartH);
  card.addSpacer(2);
  const axis = card.addStack();
  addText(axis, fmtClock(Date.now() - CHART_HOURS * 3600 * 1000), 9, COLORS.sub);
  axis.addSpacer();
  addText(axis, t("chart.now"), 9, COLORS.sub);
  return card;
}

function largeHero(w, v, opts = {}) {
  const inner = widgetSizes().wide - 24;
  w.setPadding(14, 12, 14, 12);
  heroHeader(w, v);
  w.addSpacer(10);
  const row = w.addStack();
  row.centerAlignContent();
  ring(row, v, 104, 10, 30);
  row.addSpacer(16);
  const info = row.addStack();
  info.layoutVertically();
  heroHeadline(info, v, 28);
  row.addSpacer();
  w.addSpacer(12);
  const stored = storedOf(v);
  // without the charge chart there is room: bigger numbers, units small beside them
  const roomy = Boolean(opts.footer);
  const tiles = w.addStack();
  tiles.spacing = 8;
  const unitW = (inner - 16) / 10; // in / out / stored = 3 : 3 : 4 — "кВт·год" needs the width
  const split = (text) => {
    const i = text.lastIndexOf(" ");
    return i === -1 ? [text, ""] : [text.slice(0, i), text.slice(i + 1)];
  };
  for (const [label, value, icon, color, span] of [
    [t("in"), fmtW(v.inW), "arrow.down.to.line.compact", COLORS.blue, 3],
    [t("out"), fmtW(v.outW), "arrow.up.to.line.compact", COLORS.orange, 3],
    [t("stored"), stored != null ? `≈ ${fmtWh(stored)}` : "—", "battery.100", COLORS.green, 4],
  ]) {
    const tile = tiles.addStack();
    tile.layoutVertically();
    tile.size = new Size(Math.floor(unitW * span), 0);
    tile.backgroundColor = COLORS.card;
    tile.cornerRadius = 12;
    tile.setPadding(roomy ? 10 : 8, 10, roomy ? 10 : 8, 10);
    const top = tile.addStack();
    top.centerAlignContent();
    addIcon(top, icon, roomy ? 11 : 9, color);
    top.addSpacer(4);
    addText(top, label, roomy ? 13 : 10, COLORS.sub, "medium");
    top.addSpacer();
    tile.addSpacer(roomy ? 4 : 2);
    if (!roomy) {
      addText(tile, value, 15, COLORS.text, "semibold");
      continue;
    }
    const [number, unit] = split(value.replace("≈ ", "≈"));
    const row = tile.addStack();
    row.bottomAlignContent();
    addText(row, number, 24, COLORS.text, "bold");
    if (unit) {
      row.addSpacer(3);
      const u = addText(row, unit, 12, COLORS.sub, "semibold");
      u.minimumScaleFactor = 0.8;
    }
    row.addSpacer();
  }
  if (opts.footer) {
    // with a schedule, when the light goes off matters more than the last hours' charge curve
    w.addSpacer();
    opts.footer(w, "hero");
    return w;
  }
  w.addSpacer(10);
  chartCard(w, v, opts.history, inner, 62);
  return w;
}

// ── Lock screen ──
// iOS draws these "vibrant": hue is discarded and luminance/alpha map to one system tint, so the
// hierarchy is white at different alphas + weight + size. Modelled on the iOS Batteries widget:
// ring gauges, the ring opens at 12 o'clock around a bolt while charging.

const white = (a) => new Color("#FFFFFF", a);
const LOCK_TRACK = 0.3;
const INLINE_MAX_CHARS = 30;

// Usable width of the rectangular family: ≈155pt on mini/SE, 158 on 6.1", 168 on Pro Max.
function lockRowWidth() {
  let sw = 390;
  try {
    const s = Device.screenSize();
    sw = Math.min(s.width, s.height);
  } catch (_) {
    // keep default
  }
  return sw <= 375 ? 155 : sw >= 428 ? 168 : 158;
}

// Duration with a unit — never "5:40", which right under the lock-screen clock reads as a time of day.
function fmtDurationCompact(min) {
  if (min == null) return "";
  if (min >= LONG_MIN) return t("durc.long");
  const m = Math.max(1, Math.round(min));
  if (m < 60) return t("durc.m", { m });
  const h = m / 60;
  if (h < 10) return t("durc.h", { h: dec(h, 1).replace(/[.,]0$/, "") });
  if (h < 48) return t("durc.h", { h: Math.round(h) });
  return t("durc.d", { d: Math.floor(h / 24) });
}

// Compact time for a gauge; cached readings get no time (it would be stale by an unknown amount).
const lockTime = (v) => (isBroken(v) || v.state === "offline" || v.stale || v.minutes == null ? null : fmtDurationCompact(v.minutes));

// The station that runs out first: soonest by minutes when both are known, else the lowest charge.
function lockHero(views) {
  const draining = views.filter((v) => v.state === "discharging" && !v.stale && !v.demo && v.soc != null);
  draining.sort((a, b) => (a.minutes != null && b.minutes != null ? a.minutes - b.minutes : a.soc - b.soc));
  return draining[0] || null;
}

// Closed outline of a thick arc with round ends — one fill, so translucent white never doubles up.
function arcPath(c, r, w, a0, a1) {
  const p = new Path();
  const pt = (rad, a) => new Point(c + rad * Math.sin(a), c - rad * Math.cos(a));
  const steps = Math.max(2, Math.ceil((a1 - a0) / (Math.PI / 90)));
  const cap = (a, isEnd) => {
    const q = pt(r, a);
    const u = [Math.sin(a), -Math.cos(a)]; // radial, outwards
    const tg = [Math.cos(a), Math.sin(a)]; // tangent, clockwise
    const k = isEnd ? 1 : -1; // end cap: outer → ahead → inner; start cap: inner → behind → outer
    for (let i = 1; i < 12; i++) {
      const th = (Math.PI * i) / 12;
      p.addLine(new Point(q.x + (w / 2) * k * (u[0] * Math.cos(th) + tg[0] * Math.sin(th)), q.y + (w / 2) * k * (u[1] * Math.cos(th) + tg[1] * Math.sin(th))));
    }
  };
  p.move(pt(r + w / 2, a0));
  for (let i = 1; i <= steps; i++) p.addLine(pt(r + w / 2, a0 + ((a1 - a0) * i) / steps));
  cap(a1, true);
  for (let i = steps; i >= 0; i--) p.addLine(pt(r - w / 2, a0 + ((a1 - a0) * i) / steps));
  cap(a0, false);
  p.closeSubpath();
  return p;
}

function lockRingImage(pct, size, line, opts = {}) {
  const ctx = newContext(size, size);
  const c = size / 2;
  const r = c - line / 2;
  const fill = opts.fill || COLORS.white;
  const boltH = opts.bolt ? Math.max(8, Math.round(line * 2.3)) : 0;
  const gap = opts.bolt ? (boltH * 0.34 + line / 2 + 2) / r : 0; // half-angle of the opening
  const from = gap;
  const to = 2 * Math.PI - gap;
  const p = Math.max(0, Math.min(100, pct || 0));
  if (gap) {
    ctx.addPath(arcPath(c, r, line, from, to));
    ctx.setFillColor(white(LOCK_TRACK));
    ctx.fillPath();
  } else {
    ctx.setLineWidth(line);
    ctx.setStrokeColor(white(LOCK_TRACK));
    ctx.strokeEllipse(new Rect(line / 2, line / 2, size - line, size - line));
  }
  if (p >= 100 && !gap) {
    ctx.setStrokeColor(fill);
    ctx.strokeEllipse(new Rect(line / 2, line / 2, size - line, size - line));
  } else if (p > 0) {
    ctx.addPath(arcPath(c, r, line, from, from + ((to - from) * p) / 100));
    ctx.setFillColor(fill);
    ctx.fillPath();
  }
  if (opts.bolt) {
    ctx.addPath(boltPath(c, boltH / 2 + 0.5, boltH));
    ctx.setFillColor(fill);
    ctx.fillPath();
  }
  return ctx.getImage();
}

// A row of fixed width with centred content: text inside shrinks (minimumScaleFactor) instead of spilling.
function capped(parent, width, fill) {
  const row = parent.addStack();
  row.size = new Size(width, 0);
  row.centerAlignContent();
  row.addSpacer();
  fill(row);
  row.addSpacer();
  return row;
}

// Ring gauge with the short name (optional) above the percent and the time (optional) below it.
// Off-centre rows stay inside the ring's inner chord (≈62% of the size); the centred percent gets the full inner width.
function lockGauge(parent, v, size, line, numSize, opts = {}) {
  const broken = isBroken(v);
  const offline = v.state === "offline";
  const dim = v.stale || offline || broken;
  const s = parent.addStack();
  s.size = new Size(size, size);
  s.backgroundImage = lockRingImage(broken ? 0 : v.soc, size, line, { bolt: v.state === "charging", fill: white(dim ? 0.5 : 1) });
  s.layoutVertically();
  s.centerAlignContent(); // fixed-width rows below would otherwise hug the left edge of the ring
  s.addSpacer();
  const chord = Math.floor(size * 0.62);
  if (opts.nameSize) capped(s, chord, (r) => addText(r, v.short, opts.nameSize, white(0.75), "semibold"));
  capped(s, Math.floor(size - 2 * line - 2), (r) => {
    if (broken) addIcon(r, v.state === "setup" ? "gearshape.fill" : "exclamationmark.triangle.fill", Math.round(numSize * 0.95), white(0.85));
    else if (offline) addIcon(r, "wifi.slash", Math.round(numSize * 0.95), white(0.75));
    else addPercent(r, v, v.soc >= 100 ? Math.round(numSize * 0.86) : numSize, white(dim ? 0.65 : 1));
  });
  if (opts.timeSize) {
    const time = lockTime(v);
    if (time) capped(s, chord, (r) => addText(r, time, opts.timeSize, white(0.9), "semibold"));
    else if (v.stale) capped(s, chord, (r) => addIcon(r, "clock.fill", opts.timeSize - 1, white(0.6)));
  }
  s.addSpacer();
  return s;
}

// Under a gauge in the rectangular widget: the time, or a clock for cached data. Offline/broken
// stations already carry their glyph inside the ring.
function lockStatus(row, v, size) {
  const time = lockTime(v);
  if (time) return addText(row, time, size, COLORS.white, "semibold");
  // no "17:38" here: a bare time next to the lock-screen clock reads as a second clock
  if (v.stale) return addIcon(row, "clock.fill", size - 1, white(0.6));
  return addText(row, " ", size, white(0)); // keeps the rows aligned
}

// One station: big gauge + name / headline / detail.
function rectSingle(w, v) {
  const ringSize = 54;
  const gap = 10;
  const row = w.addStack();
  row.centerAlignContent();
  lockGauge(row, v, ringSize, 5, 17);
  row.addSpacer(gap);
  const col = row.addStack();
  col.layoutVertically();
  col.size = new Size(lockRowWidth() - ringSize - gap, 0);
  const name = addText(col, v.name, 13, white(0.75), "semibold");
  name.minimumScaleFactor = 0.85; // long names truncate rather than shrink to unreadable
  let head = stateLabel(v);
  let sub = null;
  if (isBroken(v)) sub = v.error;
  else if (v.stale) sub = t("cachedAt", { time: fmtClock(v.updatedAt) });
  else if (v.state !== "offline" && v.minutes != null) {
    head = `${v.estimated ? "≈ " : ""}${v.minutes >= 600 ? fmtDurationCompact(v.minutes) : fmtDuration(v.minutes)}`;
    sub = v.minutesKind === "toFull" ? t("toFull") : t("toEmpty");
  } else if (v.state !== "offline" && ((v.inW || 0) > IDLE_W || (v.outW || 0) > IDLE_W)) {
    sub = flowLine(v, true).text;
  }
  addText(col, head, 15, COLORS.white, "bold");
  if (sub) addText(col, sub, 11, white(0.6), "medium");
  return w;
}

function rectWidget(w, views) {
  w.setPadding(0, 0, 0, 0);
  const list = views.slice(0, MAX_DEVICES);
  if (list.length === 1) return rectSingle(w, list[0]);
  const roomy = list.length <= 3;
  const colW = Math.floor(lockRowWidth() / list.length);
  const row = w.addStack();
  row.topAlignContent();
  for (const v of list) {
    const col = row.addStack();
    col.layoutVertically();
    col.size = new Size(colW, 0);
    centered(col, (s) => lockGauge(s, v, roomy ? 46 : 38, roomy ? 4.5 : 4, roomy ? 15 : 12, { nameSize: roomy ? 9 : 8 }));
    col.addSpacer(2);
    capped(col, colW - 4, (s) => lockStatus(s, v, roomy ? 11 : 10));
  }
  return w;
}

function circularWidget(w, v) {
  w.setPadding(0, 0, 0, 0);
  w.addAccessoryWidgetBackground = true;
  centered(w, (row) => lockGauge(row, v, 64, 5, 18, { nameSize: 10, timeSize: 10 }));
  return w;
}

// One line above the clock: the station that runs out first with its time; otherwise every station's charge.
function inlineWidget(w, views) {
  w.setPadding(0, 0, 0, 0);
  const list = views.slice(0, MAX_DEVICES);
  const pct = (v, withPct = true) => (v.soc == null ? "—" : `${v.soc}${withPct ? "%" : ""}`);
  const hero = lockHero(list);
  let candidates;
  if (hero && hero.minutes != null) {
    candidates = [hero.name, hero.short].flatMap((name) => [fmtDuration(hero.minutes), fmtDurationCompact(hero.minutes)]
      .map((time) => t("inline.left", { name, soc: pct(hero), time: `${hero.estimated ? "≈" : ""}${time}` })));
  } else {
    const tok = (v, withPct) => {
      if (isBroken(v)) return `${v.short} !`;
      if (v.state === "offline") return `${v.short} ✕`;
      return `${v.short} ${pct(v, withPct)}${v.state === "charging" ? "↑" : ""}${v.stale ? "?" : ""}`;
    };
    candidates = [list.map((v) => tok(v, true)).join(" · "), list.map((v) => tok(v, true)).join(" "), list.map((v) => tok(v, false)).join(" ")];
  }
  addText(w, candidates.find((c) => [...c].length <= INLINE_MAX_CHARS) || candidates[candidates.length - 1], 12, COLORS.white, "medium");
  return w;
}

function pickSingle(views, param) {
  const n = parseInt(String(param || "").trim(), 10);
  return Number.isFinite(n) && n >= 1 && n <= views.length ? views[n - 1] : null;
}

// ───────────────────────── large-text mode ─────────────────────────
// For a person with poor eyesight: two facts only — is there power (by the schedule) and until when, and how
// much the station has left. Solid colour blocks with white text (contrast ≥ 4.5:1), nothing under 15 pt.

const BIG = {
  on: new Color("#1B7A34"), // white text 5.4:1
  off: new Color("#B3261E"), // 6.3:1
  maybe: new Color("#FFC21A"), // black text 13:1
  none: new Color("#5A5A60"), // 6.6:1
  text: Color.dynamic(new Color("#000000"), new Color("#FFFFFF")),
  sub: Color.dynamic(new Color("#2B2B2F"), new Color("#E6E6EA")),
  bg: Color.dynamic(new Color("#FFFFFF"), new Color("#000000")),
  card: Color.dynamic(new Color("#EDEDF2"), new Color("#1C1C20")),
};

// { color, ink, icon, head, sub } for the outage block
function bigOutage(sched, now = Date.now()) {
  const st = outageStatus(sched, now);
  const black = new Color("#000000");
  const white = COLORS.white;
  if (!st) return { color: BIG.none, ink: white, icon: "questionmark.circle.fill", head: t("big.unknown"), sub: (sched && sched.error) || null };
  if (st.kind === "emergency") return { color: BIG.off, ink: white, icon: "exclamationmark.triangle.fill", head: t("big.emergency"), sub: t("big.emergencyNote") };
  if (st.kind === "waiting") return { color: BIG.none, ink: white, icon: "clock.fill", head: t("big.waiting"), sub: null };
  const until = st.until ? t("big.until", { time: fmtWhen(st.until) }) : st.atLeast ? t("big.atLeast", { time: fmtEdge(st.atLeast) }) : null;
  if (st.kind === "off") return { color: BIG.off, ink: white, icon: "lightbulb.slash.fill", head: t("big.off"), sub: until };
  if (st.kind === "maybe") return { color: BIG.maybe, ink: black, icon: "exclamationmark.circle.fill", head: t("big.maybe"), sub: until };
  const sub = !st.next ? t(!st.todayOnly ? "big.noPlan" : st.hadToday ? "big.noMoreToday" : "big.noneToday") : t(st.next.kind === "off" ? "big.offAt" : "big.maybeAt", { time: fmtWhen(st.next.start) });
  return { color: BIG.on, ink: white, icon: "lightbulb.fill", head: t("big.on"), sub };
}

function bigOutageBlock(parent, sched, size) {
  const o = bigOutage(sched);
  const box = parent.addStack();
  box.layoutVertically();
  box.backgroundColor = o.color;
  box.cornerRadius = 16;
  box.setPadding(size.pad, 14, size.pad, 14);
  const top = box.addStack();
  top.centerAlignContent();
  addIcon(top, o.icon, size.head, o.ink);
  top.addSpacer(8);
  addText(top, o.head, size.head, o.ink, "bold");
  top.addSpacer();
  if (o.sub) {
    box.addSpacer(2);
    const row = box.addStack();
    const tx = addText(row, o.sub, size.sub, o.ink, "semibold");
    tx.minimumScaleFactor = 0.7;
    row.addSpacer();
  }
  if (sched && sched.stale) {
    box.addSpacer(2);
    addText(box, t("cachedAt", { time: fmtClock(sched.fetchedAt) }), 15, o.ink, "medium");
  }
  return box;
}

// Today's bar, thick, with 0 / 6 / 12 / 18 / 24 underneath.
function bigTimeline(parent, sched, width) {
  const todayKey = dayKey(new Date());
  const day = ((sched && sched.days) || []).find((d) => d.date === todayKey);
  if (!day || !day.slots) return;
  const img = parent.addImage(outageBarImage(day.slots, width, 22, (Date.now() - dayStart(day.date)) / 86400000, 4));
  img.imageSize = new Size(width, 22);
  parent.addSpacer(2);
  hourTicks(parent, width, 15, BIG.sub, "semibold");
}

// The outages still ahead today, one per line, in big digits: "16:00 – 18:00".
function bigWindows(parent, sched, maxRows) {
  const wins = outageWindows(sched, dayKey(new Date()), Date.now(), true);
  if (!wins || !wins.length || maxRows < 1) return;
  addText(parent, t("big.windows"), 16, BIG.sub, "semibold");
  for (const win of wins.slice(0, maxRows)) {
    parent.addSpacer(2);
    const row = parent.addStack();
    row.centerAlignContent();
    const dot = row.addStack();
    dot.size = new Size(12, 12);
    dot.cornerRadius = 6;
    dot.backgroundColor = win.endsWith("?") ? BIG.maybe : BIG.off;
    row.addSpacer(8);
    const tx = addText(row, win.replace("–", " – "), 26, BIG.text, "bold");
    tx.minimumScaleFactor = 1;
    row.addSpacer();
  }
}

// "64%" huge on the left, then what it means: "Gendome / ще 5 год 42 хв".
function bigStation(parent, v, size) {
  const row = parent.addStack();
  row.centerAlignContent();
  row.backgroundColor = BIG.card;
  row.cornerRadius = 16;
  row.setPadding(size.pad, 14, size.pad, 14);
  const low = v.soc != null && v.soc < 20;
  const pct = addPercent(row, v, size.pct, low ? BIG.off : BIG.text);
  row.addSpacer(12);
  const col = row.addStack();
  col.layoutVertically();
  addText(col, v.name, Math.max(15, size.sub - 5), BIG.sub, "semibold");
  const time = isBroken(v) ? null : timeText(v);
  let note = null;
  if (isBroken(v)) note = v.error || stateLabel(v);
  else if (v.stale) note = t("cachedAt", { time: fmtClock(v.updatedAt) });
  else if (time) note = t(v.minutesKind === "toFull" ? "big.toFull" : "big.left", { time });
  else note = stateLabel(v);
  const tx = addText(col, note, size.sub, BIG.text, "bold");
  tx.minimumScaleFactor = 0.6;
  row.addSpacer();
  return pct && row;
}

function bigWidget(w, views, family, opts) {
  const { small, wide } = widgetSizes();
  const sched = opts.outage;
  const stations = views.filter((v) => !v.demo); // sample numbers would only confuse here
  const wantStation = /^(station|станція|battery)$/i.test(String(opts.param || "").trim());
  w.backgroundColor = BIG.bg;
  if (family === "small") {
    w.setPadding(10, 10, 10, 10);
    if (sched && !wantStation) {
      const o = bigOutage(sched);
      w.backgroundColor = o.color; // the whole tile is the answer
      addIcon(w, o.icon, 30, o.ink);
      w.addSpacer(6);
      const head = addText(w, o.head, 26, o.ink, "bold");
      head.lineLimit = 2;
      head.minimumScaleFactor = 0.5;
      w.addSpacer(4);
      if (o.sub) {
        const sub = addText(w, o.sub, 22, o.ink, "semibold");
        sub.lineLimit = 2;
      }
      w.addSpacer();
      return w;
    }
    const v = stations[0];
    if (!v) return emptyWidget(w, t("noDevices"));
    addText(w, v.name, 18, BIG.sub, "semibold");
    w.addSpacer();
    addPercent(w, v, 58, v.soc != null && v.soc < 20 ? BIG.off : BIG.text);
    const time = timeText(v);
    if (time) addText(w, time, 22, BIG.text, "bold");
    return w;
  }
  const large = family === "large" || family === "extraLarge";
  const inner = wide - 24;
  w.setPadding(12, 12, 12, 12);
  const size = large ? { head: 30, sub: 24, pct: 44, pad: 12 } : { head: 24, sub: 20, pct: 36, pad: 7 };
  if (sched) bigOutageBlock(w, sched, size);
  const list = stations.slice(0, large ? 2 : 1);
  if (sched && (large || !list.length)) {
    w.addSpacer(large ? 12 : 10);
    bigTimeline(w, sched, inner);
  }
  for (const v of list) {
    w.addSpacer(large ? 12 : 8);
    bigStation(w, v, sched ? size : { head: 30, sub: 24, pct: large ? 64 : 52, pad: 14 });
  }
  if (!sched && !list.length) return emptyWidget(w, t("noDevices"));
  if (sched && large) {
    // the room that is left: the outages still ahead today
    w.addSpacer(10);
    bigWindows(w, sched, list.length >= 2 ? 0 : list.length === 1 ? 2 : 5);
  }
  w.addSpacer();
  return w;
}

function buildWidget(allViews, family, opts0 = {}) {
  let opts = opts0;
  const w = new ListWidget();
  const regular = Date.now() + (opts.refreshMin || 5) * 60000;
  const change = opts.outage ? outageNextChange(opts.outage) : null; // flip right when the light goes off / comes back
  w.refreshAfterDate = new Date(change && change > Date.now() && change < regular ? change + 15000 : regular);
  const accessory = String(family || "").startsWith("accessory");
  if (!accessory) w.backgroundColor = COLORS.bg;
  if (!accessory && (opts.big || /^big$/i.test(String(opts.param || "").trim()))) {
    // stations in use first, like the regular widget
    const real = allViews.filter((v) => !v.demo);
    const active = activeViews(real);
    return bigWidget(w, active.length ? active : real, family, opts);
  }
  // the schedule is set up but no station is: the widget is about the light, not about sample stations
  if (!accessory && opts.outage && !allViews.some((v) => !v.demo) && !pickSingle(allViews, opts.param)) return outageOnlyWidget(w, opts.outage, family);
  if (!allViews.length) {
    if (!accessory) return emptyWidget(w, t("noDevices"));
    addText(w, `⚡ ${t("noDevices")}`, 12, COLORS.white);
    return w;
  }
  // the parameter counts stations as in the menu, demo ones included
  const pinned = pickSingle(allViews, opts.param);
  // once a real station is set up, demo placeholders disappear: sample numbers must not mix with real ones
  const real = allViews.filter((v) => !v.demo);
  let views = real.length ? real : allViews;
  // "active only": just the stations in use; when nothing is in use, show them all rather than nothing
  const wantAll = opts.show === "all" || /^all$/i.test(String(opts.param || "").trim());
  if (!pinned && !wantAll) {
    const active = activeViews(views);
    if (active.length) views = active;
  }
  const hero = pinned || (views.length === 1 ? views[0] : null); // one station → it fills the widget
  if (opts.outage) {
    const { wide } = widgetSizes();
    opts = Object.assign({}, opts, { footer: (box, fam) => outageFooter(box, opts.outage, fam === "medium" ? wide - 28 : wide - 24, fam === "hero" ? "l" : fam === "large" ? "m" : "s") });
  }
  switch (family) {
    case "accessoryInline": return inlineWidget(w, hero ? [hero] : views);
    case "accessoryCircular": return circularWidget(w, hero || lockHero(views) || views[0]);
    case "accessoryRectangular": return rectWidget(w, hero ? [hero] : views);
    case "small": return hero ? smallSingle(w, hero, opts) : smallList(w, views);
    case "large":
    case "extraLarge": return hero ? largeHero(w, hero, opts) : largeWidget(w, views, opts);
    default: return hero ? mediumHero(w, hero, opts) : mediumWidget(w, views, opts);
  }
}

// ───────────────────────── in-app setup ─────────────────────────

async function info(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction(t("ok"));
  await a.presentAlert();
}

async function form(title, message, fields, okLabel = t("save")) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  for (const f of fields) {
    if (f.secure) a.addSecureTextField(f.placeholder, f.value || "");
    else a.addTextField(f.placeholder, f.value == null ? "" : String(f.value));
  }
  a.addAction(okLabel);
  a.addCancelAction(t("cancel"));
  if ((await a.presentAlert()) === -1) return null;
  return fields.map((_, i) => a.textFieldValue(i).trim());
}

async function choose(title, message, labels) {
  const a = new Alert();
  a.title = title;
  if (message) a.message = message;
  labels.forEach((l) => a.addAction(l));
  a.addCancelAction(t("cancel"));
  return a.presentSheet();
}

async function setupEcoFlow(d) {
  const values = await form(
    "EcoFlow Open API",
    t("ef.note"),
    [
      { placeholder: "Access Key", value: d.accessKey },
      { placeholder: "Secret Key", value: d.secretKey, secure: true },
      { placeholder: t("ef.server"), value: d.host || EF_HOSTS[0] },
    ],
    t("ef.find"),
  );
  if (!values) return;
  [d.accessKey, d.secretKey] = values;
  d.host = values[2].replace(/^https?:\/\//, "").replace(/\/.*$/, "") || EF_HOSTS[0];
  let list;
  try {
    list = await ecoflowRequest(d, "/iot-open/sign/device/list", {}, { dirty: false }); // may switch d.host to the key's region
  } catch (e) {
    await info(t("setup.connectFailed"), t("setup.checkKeys", { msg: e.message }));
    return;
  }
  if (!Array.isArray(list) || !list.length) {
    await info(t("setup.noDevices"), t("setup.efLinked"));
    return;
  }
  const i = await choose(t("setup.choose"), null, list.map((x) => `${Number(x.online) === 1 ? "🟢" : "⚪️"} ${x.deviceName || x.productName || "EcoFlow"} · ${x.sn}`));
  if (i === -1) return;
  d.sn = list[i].sn;
  d.model = list[i].productName || "";
}

// Authorization-code login in a WebView: the vendor's own page takes the password, and the redirect to
// `redirect` is intercepted before it loads. Falls back to Safari + pasting the final address.
async function oauthLogin(url, redirect, state) {
  let callback = null;
  const wv = new WebView();
  wv.shouldAllowRequest = (req) => {
    if (String(req.url).startsWith(redirect)) {
      callback = req.url;
      wv.loadHTML(`<meta name=viewport content='width=device-width'><body style='font:20px -apple-system;text-align:center;padding-top:40%'>${t("oauth.done")}</body>`);
      return false;
    }
    return true;
  };
  await wv.loadURL(url);
  await wv.present(false);
  if (!callback) {
    const pick = await choose(t("oauth.notCompleted"), t("oauth.safariNote", { prefix: redirect }), [t("oauth.openSafari"), t("oauth.paste")]);
    if (pick === -1) return null;
    if (pick === 0) {
      Safari.open(url);
      // this alert waits until the user is back with the address copied; only then read the clipboard
      await info(t("oauth.pasteTitle"), t("oauth.safariBack", { prefix: redirect }));
    }
    for (;;) {
      const clip = Pasteboard.paste() || "";
      const pasted = await form(t("oauth.pasteTitle"), t("oauth.pasteNote", { prefix: redirect }), [{ placeholder: `${redirect}?code=…`, value: clip.startsWith(redirect) ? clip : "" }], t("done"));
      if (!pasted) return null;
      if (pasted[0].startsWith(redirect) && queryParam(pasted[0], "code")) {
        callback = pasted[0];
        break;
      }
    }
  } else if (queryParam(callback, "state") !== state) {
    throw new Error(t("err.state"));
  }
  const err = queryParam(callback, "error");
  if (err) throw new Error(err);
  const code = queryParam(callback, "code");
  if (!code) throw new Error(t("err.noCode"));
  return code;
}

// Shared OAuth setup: sign in when needed, then pick a station from the account.
async function setupOAuthStation(d, opts) {
  const ctx = { dirty: false };
  try {
    let needLogin = !d.auth || !d.auth.refreshToken;
    if (!needLogin) {
      const c = await choose(opts.title, t("oauth.signedIn"), [t("oauth.chooseStation"), t("oauth.signInAgain")]);
      if (c === -1) return;
      needLogin = c === 1;
    }
    if (needLogin) {
      await info(opts.loginTitle, opts.loginNote);
      const tokens = await opts.login();
      if (!tokens) return;
      storeTokens(d, tokens);
    }
    const list = await opts.list(ctx);
    if (!list.length) {
      await info(t("setup.noDevices"), opts.emptyNote);
      return;
    }
    const i = await choose(t("setup.choose"), null, list.map((x) => `${x.online ? "🟢" : "⚪️"} ${x.name} · ${x.sn}`));
    if (i === -1) return;
    await opts.pick(list[i], ctx);
  } catch (e) {
    await info(`${opts.title}: ${t("err.generic")}`, e.message);
  }
}

async function setupBluetti(d) {
  await setupOAuthStation(d, {
    title: "Bluetti",
    loginTitle: t("bl.loginTitle"),
    loginNote: t("bl.loginNote"),
    emptyNote: t("setup.blLinked"),
    login: async () => {
      const state = randomString(24);
      const url = `${BLUETTI.sso}/oauth2/grant?response_type=code&client_id=${encodeURIComponent(BLUETTI.clientId)}` +
        `&redirect_uri=${encodeURIComponent(BLUETTI.redirect)}&state=${state}`;
      const code = await oauthLogin(url, BLUETTI.redirect, state);
      return code && bluettiTokenRequest({ grant_type: "authorization_code", code, redirect_uri: BLUETTI.redirect });
    },
    list: async (ctx) => {
      const list = await bluettiCall(d, ctx, "/api/bluiotdata/ha/v1/devices");
      return (Array.isArray(list) ? list : []).map((x) => ({ sn: x.sn, model: x.model || "", name: x.name || x.model || "Bluetti", online: truthy(x.online) }));
    },
    pick: async (x, ctx) => {
      // Bluetooth-only models (EB3A) are listed but never report to the cloud
      if (/EB3A/i.test(`${x.model} ${x.name}`)) {
        if ((await choose(t("bl.btOnlyTitle"), t("bl.btOnly", { model: "EB3A" }), [t("bl.useHa")])) === 0) {
          delete d.auth; // the BLUETTI login is useless for a Bluetooth-only station
          d.type = "homeassistant";
          await setupHomeAssistant(d);
        }
        return;
      }
      d.sn = x.sn;
      d.model = x.model;
      await bluettiCall(d, ctx, "/api/bluiotdata/ha/v1/bindDevices", { method: "POST", json: { bindSnList: [d.sn] } });
    },
  });
}

async function setupGendome(d) {
  await setupOAuthStation(d, {
    title: "Gendome",
    loginTitle: t("gd.loginTitle"),
    loginNote: t("gd.loginNote"),
    emptyNote: t("setup.gdLinked"),
    login: async () => {
      const state = randomString(24);
      const verifier = randomString(64); // PKCE: [A-Za-z0-9-_], 43–128 chars
      const q = (k, v) => `${k}=${encodeURIComponent(v)}`;
      const url = `${GENDOME.oauth}/oauth/authorize?${[
        q("response_type", "code"), q("client_id", GENDOME.clientId), q("redirect_uri", GENDOME.redirect), q("scope", GENDOME.scope),
        q("state", state), q("code_challenge", Crypto.sha256Base64Url(verifier)), q("code_challenge_method", "S256"),
      ].join("&")}`;
      const code = await oauthLogin(url, GENDOME.redirect, state);
      return code && gendomeTokenRequest({ grant_type: "authorization_code", code, redirect_uri: GENDOME.redirect, code_verifier: verifier });
    },
    list: async (ctx) => {
      const list = await gendomeCall(d, ctx, "/devices");
      return (Array.isArray(list) ? list : []).map((x) => ({ sn: String(x.deviceId), model: x.model || "", name: x.name || x.model || "Gendome", online: truthy(x.online) }));
    },
    pick: async (x) => {
      d.sn = x.sn;
      d.model = x.model;
    },
  });
}

// Finds the sensors the bluetti_bt integration (Patrick762/hassio-bluetti-bt) creates for a station.
async function haFindBluetti(d) {
  const base = String(d.url || "").replace(/\/+$/, "");
  const res = await http(`${base}/api/states`, { headers: { Authorization: `Bearer ${d.token}` } });
  if (res.status === 401) throw new UserError(t("err.haToken"));
  if (!Array.isArray(res.data)) throw new Error(`HA: HTTP ${res.status}`);
  const ids = new Set(res.data.map((s) => s.entity_id));
  const prefixes = [...ids]
    .map((id) => (id.match(/^(sensor\..+)_battery_soc$/) || [])[1])
    .filter((p) => p && ids.has(`${p}_ac_output_power`) && ids.has(`${p}_ac_input_power`))
    .sort((a, b) => Number(/eb3a/i.test(b)) - Number(/eb3a/i.test(a)));
  if (!prefixes.length) return null;
  let p = prefixes[0];
  if (prefixes.length > 1) {
    const i = await choose(t("ha.pickDevice"), null, prefixes.map((x) => x.replace(/^sensor\./, "")));
    if (i === -1) return null;
    p = prefixes[i];
  }
  const sum = (...names) => names.map((n) => `${p}_${n}`).filter((id) => ids.has(id)).join(" + ");
  return { soc: `${p}_battery_soc`, inW: sum("ac_input_power", "dc_input_power"), outW: sum("ac_output_power", "dc_output_power"), remainMin: "" };
}

async function setupHomeAssistant(d) {
  const kind = await choose("Home Assistant", t("ha.templateNote"), [t("ha.templateEb3a"), t("ha.templateManual")]);
  if (kind === -1) return;
  if (kind === 0) {
    const conn = await form("Home Assistant", t("ha.connNote"), [
      { placeholder: "https://ha.example.com:8123", value: d.url },
      { placeholder: t("ha.token"), value: d.token, secure: true },
    ], t("ha.find"));
    if (!conn) return;
    [d.url, d.token] = conn;
    try {
      const found = await haFindBluetti(d);
      if (found) {
        d.entities = Object.assign({}, d.entities, found);
        if (!d.capacityWh) d.capacityWh = 268.8; // EB3A; it reports no remaining time, the widget estimates it
      } else {
        await info(t("ha.notFoundTitle"), t("ha.notFoundNote"));
      }
    } catch (err) {
      await info(t("setup.connectFailed"), err.message);
    }
  }
  const e = d.entities || {};
  const values = await form("Home Assistant", t("ha.note"), [
    { placeholder: "https://ha.example.com:8123", value: d.url },
    { placeholder: t("ha.token"), value: d.token, secure: true },
    { placeholder: t("ha.soc"), value: e.soc },
    { placeholder: t("field.inW"), value: e.inW },
    { placeholder: t("field.outW"), value: e.outW },
    { placeholder: t("ha.remain"), value: e.remainMin },
  ]);
  if (!values) return;
  [d.url, d.token] = values;
  d.entities = Object.assign({}, e, { soc: values[2], inW: values[3], outW: values[4], remainMin: values[5] });
}

async function setupJson(d) {
  const values = await form("JSON URL", t("json.note"), [
    { placeholder: "https://…", value: d.url },
    { placeholder: t("json.header"), value: d.header, secure: true },
  ]);
  if (!values) return;
  [d.url, d.header] = values;
}

async function editBasics(d) {
  const values = await form(t("basics.title"), t("basics.note"), [
    { placeholder: t("basics.name"), value: d.name },
    { placeholder: t("basics.short"), value: d.short },
    { placeholder: t("basics.capacity"), value: d.capacityWh || "" },
  ]);
  if (!values) return;
  d.name = values[0] || d.name;
  d.short = values[1].slice(0, 3);
  d.capacityWh = num(values[2]) || 0;
}

async function editKeys(d) {
  const k = d.keys || {};
  const fields = ["soc", "inW", "outW", "chgMin", "dsgMin", "remainMin"];
  const values = await form(t("keys.title"), t("keys.note"), fields.map((key) => ({ placeholder: t(`field.${key}`), value: k[key] })));
  if (!values) return;
  d.keys = {};
  fields.forEach((key, i) => { if (values[i]) d.keys[key] = values[i]; });
}

async function chooseType(d) {
  const types = Object.keys(PROVIDERS);
  const i = await choose(t("source.title"), t("source.note"), types.map(typeLabel));
  if (i === -1) return;
  if (d.type !== types[i]) {
    // another vendor's login, serial, keys and field overrides mean nothing for the new source
    for (const k of ["auth", "sn", "model", "keys", "accessKey", "secretKey", "host", "entities", "url", "token", "header"]) delete d[k];
  }
  d.type = types[i];
  if (PROVIDERS[d.type].setup) await PROVIDERS[d.type].setup(d);
}

async function testDevice(d) {
  try {
    const { reading } = await PROVIDERS[d.type].fetch(d, { dirty: false });
    const v = finalize(d, reading);
    const time = timeText(v);
    await info(`${d.name}: ${stateLabel(v)}`, [
      t("test.charge", { v: v.soc == null ? "—" : `${v.soc}%` }),
      t("test.in", { v: fmtW(v.inW) }),
      t("test.out", { v: fmtW(v.outW) }),
      time ? t(v.minutesKind === "toFull" ? "test.toFull" : "test.toEmpty", { v: time }) : null,
    ].filter(Boolean).join("\n"));
  } catch (e) {
    await info(t("test.error", { name: d.name }), e.message);
  }
}

async function editDevice(cfg, idx) {
  const d = cfg.devices[idx];
  const provider = PROVIDERS[d.type] || {};
  const actions = [];
  const labels = [];
  const add = (label, fn) => { labels.push(label); actions.push(fn); };
  add(t("dev.basics"), () => editBasics(d));
  add(t("dev.source", { label: typeLabel(d.type) }), () => chooseType(d));
  if (provider.setup) add(provider.oauth ? t("dev.oauthConnect") : t("dev.connect"), () => provider.setup(d));
  if (provider.keys) add(t("dev.keys"), () => editKeys(d));
  add(t("dev.test"), () => testDevice(d));
  if (idx > 0) add(t("dev.up"), () => { cfg.devices.splice(idx - 1, 0, cfg.devices.splice(idx, 1)[0]); });

  const a = new Alert();
  a.title = d.name;
  a.message = [typeLabel(d.type), d.sn ? `SN ${d.sn}` : null, d.model || null].filter(Boolean).join(" · ");
  labels.forEach((l) => a.addAction(l));
  a.addDestructiveAction(t("delete"));
  a.addCancelAction(t("back"));
  const i = await a.presentSheet();
  if (i === -1) return;
  if (i === labels.length) cfg.devices.splice(idx, 1);
  else await actions[i]();
  saveConfig(cfg); // providers may have refreshed tokens on `d`
}

async function preview(cfg, family) {
  const octx = { dirty: false };
  const [views, outage] = await Promise.all([loadAll(cfg), loadOutage(cfg, octx)]);
  if (octx.dirty) saveConfig(cfg);
  const w = buildWidget(views, family, { refreshMin: cfg.refreshMin, show: cfg.show, big: cfg.big, history: readJsonFile(HISTORY_FILE), outage });
  const show = {
    small: () => w.presentSmall(),
    medium: () => w.presentMedium(),
    large: () => w.presentLarge(),
    accessoryRectangular: () => w.presentAccessoryRectangular(),
  }[family];
  await show();
}

// ───────────────────────── live mode ─────────────────────────
// A full-screen dashboard that refreshes while it is open: Scriptable polls the stations and pushes
// each snapshot into a WebView with evaluateJavaScript. Links to live://… are intercepted as commands.

const LIVE_INTERVALS = [5, 10, 30];

function liveOutage(sched) {
  if (!sched) return null;
  const line = outageLine(sched);
  const todayKey = dayKey(new Date());
  const tone = { [COLORS.red]: "off", [COLORS.amber]: "maybe", [COLORS.green]: "on" };
  return {
    text: line.text,
    tone: tone[line.color] || "none",
    group: sched.group ? t("outage.group", { g: sched.group }) : "",
    stale: sched.stale ? fmtClock(sched.fetchedAt) : "",
    days: (sched.days || []).filter((d) => d.date === todayKey).map((d) => ({
      label: d.date === todayKey ? t("outage.today") : t("outage.tomorrow"),
      slots: d.slots,
      note: d.slots ? "" : d.status === "emergency" ? t("outage.emergency") : t("outage.notYet"),
      now: d.date === todayKey ? (Date.now() - dayStart(d.date)) / 86400000 : null,
    })),
  };
}

function livePayload(views, interval, outage) {
  const real = views.filter((v) => !v.demo);
  const shown = real.length ? real : views;
  const sum = summarize(shown);
  return {
    at: Date.now(),
    interval,
    outage: liveOutage(outage),
    stored: sum.storedWh != null ? fmtWh(sum.storedWh) : null,
    load: fmtW(sum.loadW),
    stations: shown.map((v) => ({
      id: v.id,
      name: v.name,
      demo: v.demo,
      soc: v.soc,
      level: v.soc == null ? "none" : v.soc >= 50 ? "ok" : v.soc >= 20 ? "mid" : "low",
      state: v.state,
      stateLabel: v.stale ? t("cachedAt", { time: fmtClock(v.updatedAt) }) : stateLabel(v),
      tint: v.stale ? "#FFB000" : stateOf(v).tint,
      time: timeText(v),
      timeLabel: v.minutesKind === "toFull" ? t("toFull") : v.minutesKind === "toEmpty" ? t("toEmpty") : "",
      inW: v.inW || 0,
      outW: v.outW || 0,
      inText: fmtW(v.inW),
      outText: fmtW(v.outW),
      stale: v.stale,
      error: isBroken(v) ? v.error || stateLabel(v) : v.stale ? v.error : null,
      updatedAt: v.updatedAt,
      rev: v.rev, // bumps on every fetch of this station, so the page knows which samples are new
    })),
  };
}

const LIVE_CSS = `
:root{--bg:#f2f2f7;--card:#fff;--text:#16171a;--sub:#6e6e76;--track:rgba(142,142,147,.22);--green:#30c85e;--amber:#ffb000;--red:#ff453a;--blue:#0a84ff;--orange:#ff7a2f;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0d0e11;--card:#1b1c21;--text:#f4f4f6;--sub:#9a9aa3}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.3 -apple-system,system-ui,sans-serif;padding:calc(env(safe-area-inset-top) + 12px) 16px calc(env(safe-area-inset-bottom) + 24px);-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
.app{color:var(--sub);font-size:13px;font-weight:600}
.row{display:flex;align-items:center;gap:10px}
h1{font-size:28px;margin:2px 0;flex:1}
.live{font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--green);display:flex;align-items:center;gap:5px}
.live i{width:8px;height:8px;border-radius:50%;background:var(--green);animation:blink 1.6s infinite}
@keyframes blink{50%{opacity:.25}}
.btn{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--card);color:var(--text);text-decoration:none;font-size:19px}
.sub{justify-content:space-between;color:var(--sub);font-size:13px;margin:6px 0 12px}
.chips{display:flex;gap:6px}
.chips a{padding:5px 11px;border-radius:999px;background:var(--card);color:var(--sub);text-decoration:none;font-weight:600;font-size:12px}
.chips a.on{background:var(--blue);color:#fff}
.summary{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
.stat{background:var(--card);border-radius:16px;padding:12px 14px}
.stat small{display:block;color:var(--sub);font-size:12px;font-weight:600}
.stat b{font-size:20px;font-variant-numeric:tabular-nums}
.card{background:var(--card);border-radius:20px;padding:14px;margin-bottom:12px}
.card.stale{opacity:.8}
.top{display:flex;gap:14px;align-items:center}
.ring{width:86px;height:86px;flex:none;overflow:visible}
.ring .track,.ring .arc{fill:none;stroke-width:8}
.ring .track{stroke:var(--track)}
.ring .arc{stroke-linecap:round;transition:stroke-dasharray .6s ease}
.lvl-ok .arc{stroke:var(--green)}.lvl-mid .arc{stroke:var(--amber)}.lvl-low .arc{stroke:var(--red)}.lvl-none .arc{stroke:transparent}
.pct{font:700 23px ui-rounded,-apple-system,system-ui,sans-serif;fill:var(--text);text-anchor:middle}
.pc{font-size:12px;fill:var(--sub)}
.badge circle{fill:var(--blue);stroke:var(--card);stroke-width:3}.badge path{fill:#fff}
.info{min-width:0;flex:1}
.name{font-weight:600;font-size:17px;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}
.name span.n{overflow:hidden;text-overflow:ellipsis}
.dot{width:7px;height:7px;border-radius:50%;background:var(--sub);flex:none;opacity:.45}
.dot.pulse{animation:pulse 1.4s ease-out}
@keyframes pulse{0%{background:var(--green);opacity:1;box-shadow:0 0 0 0 rgba(48,200,94,.7)}100%{opacity:.45;box-shadow:0 0 0 9px rgba(48,200,94,0)}}
.demo{font-size:10px;font-weight:700;color:var(--orange);background:rgba(255,122,47,.15);padding:1px 5px;border-radius:4px}
.chip{display:inline-block;margin-top:4px;font-size:12px;font-weight:600;color:var(--tint);background:color-mix(in srgb,var(--tint) 16%,transparent);padding:2px 8px;border-radius:7px}
.time{font-size:26px;font-weight:700;margin-top:6px;font-variant-numeric:tabular-nums;white-space:nowrap}
.tlabel{color:var(--sub);font-size:13px}
.flows{display:flex;justify-content:space-between;margin-top:12px;font-size:14px;color:var(--sub)}
.flows b{color:var(--text);font-variant-numeric:tabular-nums}
.sw{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:0}
.sw.in{background:var(--blue)}.sw.out{background:var(--orange)}
.spark{display:block;width:100%;height:42px;margin-top:8px}
.spark polyline{fill:none;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.spark .in{stroke:var(--blue)}.spark .out{stroke:var(--orange)}
.err{margin-top:8px;font-size:13px;color:var(--red)}.err.warn{color:var(--amber)}
.hint{color:var(--sub);font-size:12px;text-align:center;margin-top:16px}
.outage .ohead{display:flex;align-items:center;gap:8px;font-size:15px}
.outage .ohead b{flex:1;min-width:0}
.ob{width:10px;height:10px;border-radius:50%;background:var(--sub);flex:none}.ob.on{background:var(--green)}.ob.off{background:var(--red)}.ob.maybe{background:var(--amber)}
.og{color:var(--sub);font-size:12px;white-space:nowrap}
.oday{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--sub)}
.oday>span:first-child{width:62px;flex:none}
.obar{position:relative;flex:1;display:flex;gap:1px;height:12px}
.obar i{border-radius:3px;background:rgba(48,200,94,.35)}.obar i.off{background:var(--red)}.obar i.maybe{background:var(--amber)}
.obar b{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--blue);border-radius:1px}
.oticks{display:flex;justify-content:space-between;margin:4px 0 0 70px;font-size:10px;color:var(--sub)}`;

// Runs INSIDE the WebView (embedded via toString), never in Scriptable itself.
function livePage(S) {
  const hist = {}; // station id → [{i, o}] power samples of this session
  const seen = {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ago = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 3) return S.now;
    return s < 120 ? S.ago.replace("{n}", s) : S.agoMin.replace("{n}", Math.round(s / 60));
  };
  const BOLT = "M13.8 1 4 13.5h6.5L8.6 23l11-13h-6.6z";

  function ring(st) {
    const r = 34;
    const c = 2 * Math.PI * r;
    const pct = st.soc == null ? 0 : st.soc;
    const badge = st.state === "charging"
      ? `<g class="badge"><circle cx="70" cy="16" r="12"/><path d="${BOLT}" transform="translate(61.5 7) scale(.72)"/></g>` : "";
    return `<svg class="ring lvl-${st.level}" viewBox="0 0 86 86"><circle class="track" cx="43" cy="43" r="${r}"/>` +
      `<circle class="arc" cx="43" cy="43" r="${r}" stroke-dasharray="${((c * pct) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 43 43)"/>` +
      `${badge}<text x="43" y="51" class="pct">${st.soc == null ? "—" : st.soc}<tspan class="pc">%</tspan></text></svg>`;
  }

  function spark(id) {
    const h = hist[id] || [];
    if (h.length < 2) return "";
    const max = Math.max(10, ...h.map((p) => Math.max(p.i, p.o)));
    const W = 300;
    const H = 42;
    const line = (k) => h.map((p, i) => `${((i / (h.length - 1)) * W).toFixed(1)},${(H - 3 - (p[k] / max) * (H - 6)).toFixed(1)}`).join(" ");
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline class="in" points="${line("i")}"/><polyline class="out" points="${line("o")}"/></svg>`;
  }

  function card(st) {
    const err = st.error ? `<div class="err${st.stale ? " warn" : ""}">${esc(st.error)}</div>` : "";
    return `<section class="card${st.stale ? " stale" : ""}"><div class="top">${ring(st)}<div class="info">` +
      `<div class="name"><span class="dot" id="d-${esc(st.id)}"></span><span class="n">${esc(st.name)}</span>${st.demo ? `<span class="demo">${esc(S.demo)}</span>` : ""}</div>` +
      `<div class="chip" style="--tint:${esc(st.tint)}">${esc(st.stateLabel)}</div>` +
      `<div class="time">${esc(st.time || "—")}</div>` +
      `<div class="tlabel">${esc(st.timeLabel)}${st.timeLabel ? " · " : ""}<span data-ts="${st.updatedAt}">${ago(st.updatedAt)}</span></div>` +
      `</div></div><div class="flows"><span><i class="sw in"></i>${esc(S.in)} <b>${esc(st.inText)}</b></span>` +
      `<span><i class="sw out"></i>${esc(S.out)} <b>${esc(st.outText)}</b></span></div>${spark(st.id)}${err}</section>`;
  }

  function outageCard(o) {
    if (!o) return "";
    const bar = (d) => {
      if (!d.slots) return `<span>${esc(d.note)}</span>`;
      const segs = [];
      d.slots.forEach((k) => { const l = segs[segs.length - 1]; if (l && l.k === k) l.n++; else segs.push({ k, n: 1 }); });
      const now = d.now != null ? `<b style="left:${(d.now * 100).toFixed(2)}%"></b>` : "";
      return `<div class="obar">${segs.map((x) => `<i class="${x.k}" style="flex:${x.n}"></i>`).join("")}${now}</div>`;
    };
    return `<section class="card outage"><div class="ohead"><span class="ob ${o.tone}"></span><b>${esc(o.text)}</b>` +
      `<span class="og">${o.stale ? `🕒 ${esc(o.stale)} · ` : ""}${esc(o.group)}</span></div>` +
      o.days.map((d) => `<div class="oday"><span>${esc(d.label)}</span>${bar(d)}</div>`).join("") +
      (o.days.some((d) => d.slots) ? '<div class="oticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>' : "") + "</section>";
  }

  window.update = (p) => {
    const fresh = [];
    for (const st of p.stations) {
      const rev = st.rev != null ? st.rev : st.updatedAt;
      if (st.stale || st.soc == null || seen[st.id] === rev) continue;
      seen[st.id] = rev;
      const h = (hist[st.id] = hist[st.id] || []);
      h.push({ i: st.inW, o: st.outW });
      if (h.length > 120) h.shift();
      fresh.push(st.id);
    }
    $("summary").innerHTML =
      (p.stored ? `<div class="stat"><small>${esc(S.stored)}</small><b>${esc(p.stored)}</b></div>` : "") +
      `<div class="stat"><small>${esc(S.load)}</small><b>${esc(p.load)}</b></div>`;
    $("cards").innerHTML = outageCard(p.outage) + p.stations.map(card).join("");
    fresh.forEach((id) => { const d = $(`d-${id}`); if (d) d.classList.add("pulse"); });
    $("updated").dataset.ts = p.at;
    $("updated").textContent = ago(p.at);
    document.querySelectorAll(".chips a").forEach((a) => a.classList.toggle("on", Number(a.dataset.s) === p.interval));
    return true;
  };
  setInterval(() => document.querySelectorAll("[data-ts]").forEach((e) => { e.textContent = ago(Number(e.dataset.ts)); }), 1000);
}

function liveHtml() {
  const S = {
    now: t("live.now"), ago: t("live.ago"), agoMin: t("live.agoMin"), in: t("in"), out: t("out"),
    stored: t("stored"), load: t("load"), demo: t("demo"),
  };
  const chips = LIVE_INTERVALS.map((n) => `<a data-s="${n}" href="live://interval/${n}">${t("live.sec", { n })}</a>`).join("");
  return `<!doctype html><html lang="${LANG}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${LIVE_CSS}</style></head><body>` +
    `<div class="app">⚡ ${t("title")}</div>` +
    `<div class="row"><h1>${t("live.title")}</h1><span class="live"><i></i>LIVE</span><a class="btn" href="live://refresh" aria-label="${t("live.refresh")}">⟳</a></div>` +
    `<div class="row sub"><span>${t("live.updated")} <span id="updated">…</span></span><span class="chips">${chips}</span></div>` +
    `<div id="summary" class="summary"></div><main id="cards"></main><p class="hint">${t("live.hint")}</p>` +
    `<script>(${livePage.toString()})(${JSON.stringify(S)});</script></body></html>`;
}

async function liveMode(cfg) {
  let interval = LIVE_INTERVALS.includes(cfg.liveSec) ? cfg.liveSec : 10;
  let open = true;
  let force = false; // ⟳ tapped: refetch everything now
  let poke = false; // a command arrived while fetching: skip the next sleep
  let wake = () => {};
  const wv = new WebView();
  wv.shouldAllowRequest = (req) => {
    const m = String(req.url).match(/^live:\/\/(\w+)(?:\/(\d+))?/);
    if (!m) return true;
    if (m[1] === "interval" && LIVE_INTERVALS.includes(Number(m[2]))) interval = Number(m[2]);
    if (m[1] === "refresh") force = true;
    poke = true;
    wake();
    return false;
  };
  await wv.loadHTML(liveHtml());
  const closed = wv.present(true).then(() => {
    open = false;
    wake();
  });
  const cache = readCache();
  const latest = {}; // device id → { view, at }
  let rev = 0;
  let outage = null;
  let outageAt = 0;
  while (open) {
    const forced = force;
    force = false;
    poke = false;
    const ctx = { dirty: false, live: true, force: forced };
    const devices = cfg.devices.slice(0, MAX_DEVICES);
    const outageDue = forced || Date.now() - outageAt > 5 * 60 * 1000; // the schedule changes rarely
    await Promise.all([
      outageDue ? loadOutage(cfg, ctx).then((o) => { outage = o; outageAt = Date.now(); }) : null,
      ...devices.map(async (dev) => {
      const id = deviceId(dev);
      const gapMs = Math.max(interval, (PROVIDERS[dev.type] || {}).liveMinS || 5) * 1000;
      if (!forced && latest[id] && Date.now() - latest[id].at < gapMs - 500) return;
      const view = await loadOne(dev, cache, ctx);
      view.rev = ++rev;
      latest[id] = { view, at: Date.now() };
    }),
    ]);
    writeCache(cache);
    if (ctx.dirty) saveConfig(cfg);
    const views = uniqueShorts(devices.map((d) => latest[deviceId(d)].view));
    recordHistory(views);
    try {
      await checkAlerts(cfg, views);
    } catch (_) {
      // an alert must never stop the dashboard
    }
    if (!open) break;
    await wv.evaluateJavaScript(`update(${JSON.stringify(livePayload(views, interval, outage))})`, false).catch(() => null);
    if (open && !poke) {
      await new Promise((resolve) => {
        const timer = Timer.schedule(interval * 1000, false, resolve);
        wake = () => {
          timer.invalidate();
          resolve();
        };
      });
      wake = () => {};
    }
  }
  await closed;
  if (cfg.liveSec !== interval) {
    cfg.liveSec = interval;
    saveConfig(cfg);
  }
}

async function diagnostics(cfg) {
  const ctx = { dirty: false };
  const report = await Promise.all(cfg.devices.map(async (d) => {
    try {
      const { reading, raw } = await PROVIDERS[d.type].fetch(d, ctx);
      return { name: d.name, type: d.type, reading, raw };
    } catch (e) {
      return { name: d.name, type: d.type, error: String(e.message || e) };
    }
  }));
  if (ctx.dirty) saveConfig(cfg);
  const text = JSON.stringify({ version: VERSION, at: new Date().toISOString(), report }, null, 2);
  Pasteboard.copyString(text);
  await QuickLook.present(text, true);
}

async function editAlerts(cfg) {
  const a = cfg.alerts;
  const i = await choose(t("alerts.title"), t("alerts.note"), [
    a.enabled ? t("alerts.disable") : t("alerts.enable"),
    t("alerts.thresholds", { low: a.low, critical: a.critical }),
    t("alerts.test"),
  ]);
  if (i === 0) a.enabled = !a.enabled;
  if (i === 1) {
    const values = await form(t("alerts.title"), t("alerts.thresholdNote"), [
      { placeholder: t("alerts.low"), value: a.low },
      { placeholder: t("alerts.critical"), value: a.critical },
    ]);
    if (values) {
      const pct = (s) => Math.max(0, Math.min(99, Math.round(num(s) || 0)));
      a.low = pct(values[0]);
      a.critical = pct(values[1]);
    }
  }
  // the first notification also triggers the iOS permission prompt, which a widget can't show
  if (i === 2) await sendNotification(t("alerts.testTitle"), t("alerts.testBody", { low: a.low, critical: a.critical }), false);
  saveConfig(cfg);
}

// Address → group via Yasno: street (≥3 letters, pick from the list) → house → group, confirmed to the user.
async function outageAddressFlow(cfg) {
  try {
    let street = null;
    while (!street) {
      const v = await form(t("outage.streetTitle"), t("outage.streetNote"), [{ placeholder: t("outage.streetPh"), value: "" }], t("outage.find"));
      if (!v) return;
      if ([...v[0]].length < 3) {
        await info(t("outage.streetTitle"), t("outage.min3"));
        continue;
      }
      const list = (await yasnoStreets(v[0])) || [];
      if (!list.length) {
        await info(t("outage.notFound"), t("outage.notFoundStreet"));
        continue;
      }
      const k = list.length === 1 ? 0 : await choose(t("outage.pickStreet"), null, list.map((s) => s.value));
      if (k === -1) return;
      street = list[k];
    }
    let house = null;
    while (!house) {
      const v = await form(street.value, t("outage.houseNote"), [{ placeholder: t("outage.housePh"), value: "" }], t("outage.find"));
      if (!v) return;
      const list = (await yasnoHouses(street.id, v[0])) || [];
      if (!list.length) {
        await info(t("outage.notFound"), t("outage.notFoundHouse"));
        continue;
      }
      // "22" typed and "22" listed (next to "20-22", "22А") → take it without asking
      const exact = list.findIndex((h) => String(h.value).toLowerCase() === v[0].trim().toLowerCase());
      const k = exact !== -1 ? exact : list.length === 1 ? 0 : await choose(t("outage.pickHouse"), null, list.map((h) => h.value));
      if (k === -1) return;
      house = list[k];
    }
    const group = await yasnoGroup(street.id, house.id);
    if (!group) throw new Error(t("outage.noGroupFound"));
    cfg.outage = { enabled: true, street: street.value, house: house.value, streetId: street.id, houseId: house.id, group, resolvedAt: Date.now() };
    await info(t("outage.foundTitle", { g: group }), t("outage.foundNote", { addr: `${street.value}, ${house.value}` }));
  } catch (e) {
    await info(t("setup.connectFailed"), e.message);
  }
}

// Pick from a list: short lists directly, long ones after typing a few letters.
async function pickFiltered(items, label, title, note, ph) {
  let list = items;
  while (list.length > 12) {
    const v = await form(title, note || "", [{ placeholder: ph, value: "" }], t("outage.find"));
    if (!v) return null;
    const q = v[0].toLowerCase().replace(/^(вул|просп|пров|пл|бульв|м|с|смт|сел)\.?\s+/i, "").trim();
    const found = items.filter((x) => label(x).toLowerCase().includes(q));
    if (!found.length) {
      await info(t("outage.notFound"), note || "");
      continue;
    }
    list = found;
  }
  if (!list.length) return null;
  const k = list.length === 1 ? 0 : await choose(title, null, list.map(label));
  return k === -1 ? null : list[k];
}

// kiroe address: district → town → street → building, then the building's queue.
async function kiroeAddressFlow(cfg) {
  try {
    const session = await kiroeOpenSession();
    if (!session.offices.length) throw new Error(t("kiroe.noOffices"));
    const office = await pickFiltered(session.offices, (x) => x.name, t("kiroe.pickOffice"), null, "");
    if (!office) return;
    const cities = await kiroeCities(office.id, session);
    const cityLabel = (c) => `${c.CityType ? `${c.CityType}. ` : ""}${c.CityName}`;
    const city = await pickFiltered(cities, cityLabel, t("kiroe.cityTitle"), t("kiroe.cityNote"), t("kiroe.cityPh"));
    if (!city) return;
    const streets = await kiroeStreets(city.CityId, session);
    const streetLabel = (x) => `${x.StreetType ? `${x.StreetType} ` : ""}${x.StreetName}`;
    const street = await pickFiltered(streets, streetLabel, t("outage.streetTitle"), t("kiroe.streetNote"), t("outage.streetPh"));
    if (!street) return;
    const houses = await kiroeHouses(street.StreetId, session);
    let house = null;
    while (!house) {
      if (!houses.length) throw new Error(t("outage.notFound"));
      const v = await form(streetLabel(street), t("outage.houseNote"), [{ placeholder: t("outage.housePh"), value: "" }], t("outage.find"));
      if (!v) return;
      const q = v[0].trim().toLowerCase();
      const exact = houses.filter((h) => String(h.HouseName).toLowerCase() === q);
      const found = exact.length ? exact : houses.filter((h) => String(h.HouseName).toLowerCase().startsWith(q));
      if (!found.length) {
        await info(t("outage.notFound"), t("outage.notFoundHouse"));
        continue;
      }
      const k = found.length === 1 ? 0 : await choose(t("outage.pickHouse"), null, found.map((h) => String(h.HouseName)));
      if (k === -1) return;
      house = found[k];
    }
    if (!house.chergGpv) throw new Error(t("kiroe.noGroupForHouse"));
    const addr = `${cityLabel(city)}, ${streetLabel(street)}, ${house.HouseName}`;
    cfg.outage = {
      enabled: true, provider: "kiroe", group: String(house.chergGpv), resolvedAt: Date.now(),
      officeId: office.id, cityId: city.CityId, streetId: street.StreetId, houseId: house.HouseId,
      street: `${cityLabel(city)}, ${streetLabel(street)}`, house: String(house.HouseName),
    };
    await info(t("outage.foundTitle", { g: cfg.outage.group }), t("kiroe.foundNote", { addr }));
  } catch (e) {
    await info(t("setup.connectFailed"), e.message);
  }
}

async function chooseOutageProvider(cfg, current) {
  const list = Object.keys(OUTAGE_PROVIDERS);
  const k = await choose(t("outage.providerTitle"), t("outage.providerNote"), list.map((x) => t(`prov.${x}`)));
  if (k === -1) return false;
  // another provider's queues mean nothing here: start over
  if (list[k] !== current || !cfg.outage) cfg.outage = { enabled: true, provider: list[k] };
  return true;
}

async function setupOutage(cfg) {
  // first setup: ask whose schedule it is before anything else — the Yasno address search is Kyiv-only
  if (!cfg.outage || (!cfg.outage.group && !cfg.outage.provider)) {
    if (!(await chooseOutageProvider(cfg, null))) return;
    saveConfig(cfg);
  }
  const o = cfg.outage || {};
  const provider = outageProvider(o);
  const kiroe = provider === "kiroe";
  const actions = [];
  const labels = [];
  const add = (label, fn) => { labels.push(label); actions.push(fn); };
  add(t("outage.provider", { p: t(`prov.${provider}`) }), () => chooseOutageProvider(cfg, provider));
  const addressFlow = () => (kiroe ? kiroeAddressFlow(cfg) : outageAddressFlow(cfg));
  add(o.group ? t("outage.changeAddress") : t("outage.setAddress"), addressFlow);
  const enterGroup = async () => {
    const v = await form(t("outage.groupTitle"), t(kiroe ? "outage.groupNoteKiroe" : "outage.groupNote"), [{ placeholder: t("outage.groupPh"), value: o.group || "" }]);
    if (!v) return;
    const g = v[0].replace(",", ".");
    if (kiroe) {
      if (KIROE_GROUP_RE.test(g)) cfg.outage = { enabled: true, provider: "kiroe", group: g };
      else await info(t("outage.groupTitle"), t("outage.badGroupKiroe"));
    } else if (/^\d+(\.\d+)?$/.test(g)) cfg.outage = { enabled: true, group: g.includes(".") ? g : `${g}.1` };
    else await info(t("outage.groupTitle"), t("outage.badGroup"));
  };
  if (kiroe && !o.group) {
    // first kiroe setup: straight to the address
    await addressFlow();
    saveConfig(cfg);
    return;
  }
  add(t("outage.setGroup"), enterGroup);
  if (o.group) {
    add(o.enabled === false ? t("alerts.enable") : t("alerts.disable"), () => { cfg.outage.enabled = o.enabled === false; });
    add(t("outage.test"), async () => {
      const sched = await loadOutage(cfg, { dirty: false, force: true });
      const today = sched && (sched.days || []).find((d) => d.date === dayKey(new Date()));
      const offs = today && today.slots ? outageBlocks({ days: [today] }).filter((b) => b.kind !== "on") : [];
      const list = offs.map((b) => `${fmtClock(b.start)}–${b.end % 86400000 === dayStart(today.date) % 86400000 ? "24:00" : fmtClock(b.end)}${b.kind === "maybe" ? " (?)" : ""}`).join(", ");
      await info(outageLine(sched).text, [
        t("outage.group", { g: cfg.outage.group }),
        offs.length ? `${t("outage.today")}: ${list}` : today && today.slots ? `${t("outage.today")}: ${t("outage.groupOff")}` : null,
        sched && sched.stale ? t("cachedAt", { time: fmtClock(sched.fetchedAt) }) : null,
        sched && sched.error ? sched.error : null,
      ].filter(Boolean).join("\n"));
    });
    if (kiroe) {
      add(t("menu.kiroeLog"), async () => {
        const list = (readJsonFile(KIROE_LOG_FILE).list || []).slice().reverse();
        const text = [t("kiroe.log"), ...list.map((x) => `${fmtClock(x.at)} ${x.endpoint} #${x.attempt} HTTP ${x.status} · сесія ${x.sessionAgeS}s\n${x.body}`)].join("\n\n");
        Pasteboard.copyString(text); // easy to paste into a chat
        await QuickLook.present(text, true);
      });
    }
  }
  const current = o.group
    ? t("outage.current", { addr: o.street ? `${o.street}, ${o.house}` : t("outage.manual"), g: o.group })
    : t(kiroe ? "outage.noteKiroe" : "outage.note");
  const i = await choose(t(kiroe ? "outage.titleKiroe" : "outage.title"), current, labels);
  if (i !== -1) await actions[i]();
  saveConfig(cfg);
}

async function chooseLanguage(cfg) {
  const prefs = ["auto", "uk", "en"];
  const i = await choose("Мова / Language", null, [t("menu.langAuto"), LANG_NAMES.uk, LANG_NAMES.en]);
  if (i === -1) return;
  cfg.lang = prefs[i];
  LANG = resolveLang(cfg.lang);
  saveConfig(cfg);
}

// ───────────────────────── self-update ─────────────────────────
// The owner publishes the script at an HTTPS address of their own (e.g. a GitHub Gist "Raw" link) and every
// phone with that address set can update from it. Nothing is installed without a tap on "Оновити" in the app:
// widgets only notice a newer version (once a week) and send a notification.

const UPDATE_CHECK_MS = 7 * 24 * 3600 * 1000;

function versionNewer(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// Downloads the script from cfg.updateUrl → { version, code }. Throws when it isn't this script.
async function fetchUpdate(cfg) {
  const url = String(cfg.updateUrl || "").trim();
  if (!/^https:\/\//i.test(url)) throw new UserError(t("update.badUrl"));
  const r = new Request(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`); // skip CDN caches
  r.timeoutInterval = 20;
  let code;
  try {
    code = await r.loadString();
  } catch (e) {
    throw new Error(`${t("err.network")}: ${(e && e.message) || e}`);
  }
  const status = r.response ? r.response.statusCode : 0;
  if (status >= 400) throw new Error(`HTTP ${status}`);
  const version = (String(code).match(/^const VERSION = "(\d+\.\d+\.\d+)";$/m) || [])[1];
  // a web page, a truncated download or some other script must never replace this file
  const whole = version && code.length > 50000 && code.includes(`const CONFIG_KEY = "${CONFIG_KEY}"`) && /Script\.complete\(\);\s*$/.test(code);
  if (!whole) throw new Error(t("update.notScript"));
  return { version, code };
}

function installUpdate(code) {
  const path = module.filename;
  const fm = FileManager.local().isFileStoredIniCloud(path) ? FileManager.iCloud() : FileManager.local();
  fm.writeString(path, code);
}

// In the app. `manual` reports "you're up to date" and errors; the automatic check stays silent about them.
async function checkUpdate(cfg, manual) {
  try {
    const u = await fetchUpdate(cfg);
    writeJsonFile(UPDATE_FILE, { checkedAt: Date.now(), latest: u.version, notified: readJsonFile(UPDATE_FILE).notified });
    if (!versionNewer(u.version, VERSION)) {
      if (manual) await info(t("update.title"), t("update.current", { v: VERSION }));
      return false;
    }
    const i = await choose(t("update.found", { v: u.version }), t("update.foundNote", { cur: VERSION }), [t("update.install")]);
    if (i !== 0) return false;
    installUpdate(u.code);
    await info(t("update.done", { v: u.version }), t("update.doneNote"));
    return true;
  } catch (e) {
    if (manual) await info(t("update.title"), e.message);
    return false;
  }
}

// In a widget: at most once a week, and only a notification that opens the script.
async function noticeUpdate(updateUrl) {
  const st = readJsonFile(UPDATE_FILE);
  if (!updateUrl || Date.now() - (st.checkedAt || 0) < UPDATE_CHECK_MS) return;
  writeJsonFile(UPDATE_FILE, Object.assign({}, st, { checkedAt: Date.now() })); // a failing address isn't retried every refresh
  const u = await fetchUpdate({ updateUrl });
  if (!versionNewer(u.version, VERSION) || st.notified === u.version) return;
  const n = new Notification();
  n.title = t("update.found", { v: u.version });
  n.body = t("update.notifyBody");
  n.openURL = URLScheme.forRunningScript();
  n.threadIdentifier = "power-widget";
  await n.schedule();
  writeJsonFile(UPDATE_FILE, { checkedAt: Date.now(), latest: u.version, notified: u.version });
}

async function setupUpdate(cfg) {
  const labels = [t("update.setUrl")];
  if (cfg.updateUrl) labels.push(t("update.check"));
  const i = await choose(t("update.title"), cfg.updateUrl ? `v${VERSION}\n${cfg.updateUrl}` : t("update.note"), labels);
  if (i === 0) {
    const v = await form(t("update.title"), t("update.urlNote"), [{ placeholder: "https://gist.githubusercontent.com/…/raw/PowerWidget.js", value: cfg.updateUrl || "" }]);
    if (!v) return false;
    if (v[0] && !/^https:\/\//i.test(v[0])) {
      await info(t("update.title"), t("update.badUrl"));
      return false;
    }
    cfg.updateUrl = v[0];
    saveConfig(cfg);
    return v[0] ? checkUpdate(cfg, true) : false;
  }
  if (i === 1) return checkUpdate(cfg, true);
  return false;
}

async function appMenu(cfg) {
  for (;;) {
    const actions = [];
    const labels = [];
    const add = (label, fn) => { labels.push(label); actions.push(fn); };
    add(t("live.menu"), () => liveMode(cfg));
    add(t("menu.previewMedium"), () => preview(cfg, "medium"));
    add(t("menu.previewSmall"), () => preview(cfg, "small"));
    add(t("menu.previewLarge"), () => preview(cfg, "large"));
    add(t("menu.previewLock"), () => preview(cfg, "accessoryRectangular"));
    cfg.devices.forEach((d, i) => add(`⚙️ ${d.name} — ${typeLabel(d.type)}`, () => editDevice(cfg, i)));
    if (cfg.devices.length < MAX_DEVICES) {
      add(t("menu.add"), async () => {
        const d = { id: randomString(10), name: t("newDevice", { n: cfg.devices.length + 1 }), type: "demo", demo: { soc: 50 } };
        cfg.devices.push(d);
        await chooseType(d);
        await editBasics(d);
        saveConfig(cfg);
      });
    }
    add(t("menu.refresh", { n: cfg.refreshMin }), async () => {
      const opts = [5, 10, 15, 30];
      const i = await choose(t("menu.refreshTitle"), t("menu.refreshNote"), opts.map((n) => t("menu.minutes", { n })));
      if (i !== -1) cfg.refreshMin = opts[i];
      saveConfig(cfg);
    });
    add(t("menu.show", { mode: t(cfg.show === "all" ? "show.all" : "show.active") }), async () => {
      const i = await choose(t("show.title"), t("show.note"), [t("show.active"), t("show.all")]);
      if (i !== -1) cfg.show = i === 0 ? "active" : "all";
      saveConfig(cfg);
    });
    const og = cfg.outage && cfg.outage.group;
    add(t("menu.outage", { status: !og ? t("outage.notSet") : cfg.outage.enabled === false ? t("alerts.off") : t("outage.group", { g: og }) }), () => setupOutage(cfg));
    const al = cfg.alerts;
    add(t("alerts.menu", { status: al.enabled ? `≤${al.low}% · ≤${al.critical}%` : t("alerts.off") }), () => editAlerts(cfg));
    add(t("menu.big", { status: cfg.big ? t("big.statusOn") : t("alerts.off") }), async () => {
      const i = await choose(t("big.title"), t("big.note"), [cfg.big ? t("alerts.disable") : t("alerts.enable")]);
      if (i === 0) cfg.big = !cfg.big;
      saveConfig(cfg);
    });
    add(t("menu.update", { status: cfg.updateUrl ? t("update.statusOn") : t("alerts.off") }), async () => {
      if (await setupUpdate(cfg)) return "quit";
    });
    add(t("menu.lang", { lang: cfg.lang === "auto" ? `${t("menu.langAuto")} · ${LANG_NAMES[LANG]}` : LANG_NAMES[LANG] }), () => chooseLanguage(cfg));
    add(t("menu.diag"), () => diagnostics(cfg));

    const a = new Alert();
    a.title = t("menu.title");
    a.message = t("menu.message", { v: VERSION });
    labels.forEach((l) => a.addAction(l));
    a.addDestructiveAction(t("menu.reset"));
    a.addCancelAction(t("done"));
    const i = await a.presentSheet();
    if (i === -1) return;
    if (i === labels.length) {
      if ((await choose(t("menu.resetConfirm"), t("menu.resetNote"), [t("menu.resetYes")])) === 0) {
        if (Keychain.contains(CONFIG_KEY)) Keychain.remove(CONFIG_KEY);
        const m = markerFile();
        if (m.exists) m.fm.remove(m.path);
        for (const k of Object.keys(cfg)) delete cfg[k]; // outage, large text, update address… everything
        Object.assign(cfg, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
        ensureIds(cfg);
        writePublic(cfg);
        LANG = resolveLang(cfg.lang);
      }
      continue;
    }
    if ((await actions[i]()) === "quit") return; // the file was replaced: this run is the old code
  }
}

// ───────────────────────── entry ─────────────────────────

async function main() {
  const inWidget = config.runsInWidget || config.runsInAccessoryWidget;
  LANG = resolveLang("auto");
  if (!inWidget) {
    const cfg = loadConfig(false);
    LANG = resolveLang(cfg.lang);
    // opened in the app: look for a newer version at most once a day
    if (cfg.updateUrl && Date.now() - (readJsonFile(UPDATE_FILE).checkedAt || 0) > 24 * 3600 * 1000 && (await checkUpdate(cfg, false))) return;
    await appMenu(cfg);
    return;
  }
  let w;
  try {
    const cfg = loadConfig(true);
    LANG = resolveLang(cfg.lang);
    const octx = { dirty: false };
    const [views, outage] = await Promise.all([loadAll(cfg), loadOutage(cfg, octx)]);
    if (octx.dirty) saveConfig(cfg);
    writeJsonFile(VIEWS_FILE, { lang: cfg.lang, refreshMin: cfg.refreshMin, show: cfg.show, big: cfg.big, views });
    w = buildWidget(views, config.widgetFamily, { param: args.widgetParameter, refreshMin: cfg.refreshMin, show: cfg.show, big: cfg.big, history: readJsonFile(HISTORY_FILE), outage });
    try {
      await checkAlerts(cfg, views);
    } catch (_) {
      // a failed notification must not cost the widget its render
    }
  } catch (e) {
    // keychain locked (lock screen): keep showing the last readings, marked as cached
    const snap = e instanceof LockedError ? readJsonFile(VIEWS_FILE) : {};
    if (!Array.isArray(snap.views)) snap.views = [];
    if (e instanceof LockedError && (snap.views.length || readJsonFile(PUBLIC_FILE).outage)) {
      LANG = resolveLang(snap.lang || readJsonFile(PUBLIC_FILE).lang);
      const views = snap.views.map((v) => Object.assign({}, v, { stale: !v.demo }));
      // the stations need the keychain; the outage schedule doesn't — fetch it fresh even while locked
      const pub = readJsonFile(PUBLIC_FILE);
      const lite = { outage: pub.outage || null };
      const lctx = { dirty: false };
      let outage = null;
      try {
        outage = await loadOutage(lite, lctx);
        if (lctx.dirty) writeJsonFile(PUBLIC_FILE, Object.assign({}, pub, { outage: lite.outage }));
      } catch (_) {
        const o = readJsonFile(OUTAGE_FILE);
        outage = o.days ? Object.assign(o, { stale: true }) : null;
      }
      w = buildWidget(views, config.widgetFamily, {
        param: args.widgetParameter, refreshMin: snap.refreshMin || 5, show: snap.show, big: snap.big, history: readJsonFile(HISTORY_FILE), outage,
      });
    } else {
      w = new ListWidget();
      if (String(config.widgetFamily || "").startsWith("accessory")) {
        addText(w, e instanceof LockedError ? `🔒 ${t("err.lockedShort")}` : `⚡ ${e.message}`, 11, COLORS.white);
      } else emptyWidget(w, t("errorPrefix", { msg: e.message }));
      w.refreshAfterDate = new Date(Date.now() + 5 * 60000);
    }
  }
  Script.setWidget(w);
  try {
    await noticeUpdate(readJsonFile(PUBLIC_FILE).updateUrl); // after the widget is set: never delays a render
  } catch (_) {
    // next week
  }
}

await main();
Script.complete();
