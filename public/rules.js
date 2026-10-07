// Account rules + chat filter. Shared by the server (require) and the browser (window.RULES).
(function (root) {
  'use strict';
  const NICK_MIN = 3, NICK_MAX = 20, PASS_MIN = 6, PASS_MAX = 72, CHAT_MAX = 120;

  // ---------------------------------------------------------------- word lists (kept modest)
  // Patterns are tested against a normalized single word (lowercase, leet-speak mapped).
  // Anchored patterns (^…$) are for short/ambiguous words, unanchored ones are unambiguous stems.
  const BAD = [
    // English
    /fuck/, /fvck/, /shit/, /bitch/, /cunt/, /nigg/, /^nig(?:a|ah|az|er|ers)$/, /whore/, /slut/, /asshole/, /^ass(?:es)?$/,
    /^bastard/, /retard/, /porn/, /pussy/, /penis/, /vagina/, /motherf/,
    /^(?:dick|dicks|cock|cocks|fag|fags|faggot|twat|wank|wanker|sex|sexy|rape|rapist|cum|tits|boobs)$/,
    // Russian in Latin transliteration
    /^(?:hu|xu|khu)(?:i|y|j)(?!nh)/, /pizd/, /^bly(?:a|at|ad)/, /^(?:ye|e|yo|jo)b(?:at|an|al|nu|lo)/, /^suk(?:a|i)$/, /^mudak/, /^mudil/,
    /^pid(?:o|a)?r/, /^g(?:a|o)ndon/, /^zalup/, /^shl(?:yu|u|iu)h/, /^dolb(?:o|a)e?b/, /^huesos/, /^govn/, /^(?:zh|j)opa/, /^na(?:h|x)u(?:i|y|j)/,
    // Russian (Cyrillic)
    /^[хx]у[йеёиюя]/, /пизд/, /^бля/, /^[её]б(?:а|у|л|н|ё|и|ну)/, /(?:^|за|вы|до|на|от|по|про|раз|под|при|пере|у)ъ?[её]б(?:а|у|л|н|и|ну)/,
    /^сук(?:а|и|у|ой|ам|ами)$/, /^суч(?:к|ар)/, /^муда(?:к|ч)/, /^мудил/, /^пид(?:о|а)?р/, /^г(?:а|о)ндон/, /^залуп/, /^шлюх/,
    /^долбо[её]б/, /^хуесос/, /^говн/, /^жоп/, /^мраз/, /^на[хx]у[йя]/,
  ];
  // extra patterns only for nicknames
  const BAD_NAME = [/nazi/, /hitler/, /^(?:admin|administrator|moderator|mod|system|server|support|staff|owner|root|developer|dev)$/, /^(?:admin|moder|system|server|support)/];

  const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i' };
  const LAT2CYR = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', b: 'б', '0': 'о', '6': 'б', '3': 'з', '@': 'а' };
  const HAS_CYR = /[\u0400-\u04FF]/;

  function normWord(w) {
    let s = String(w).toLowerCase();
    if (HAS_CYR.test(s)) s = s.replace(/[a-z0-9@]/g, ch => LAT2CYR[ch] || ch).replace(/ё/g, 'ё');
    else s = s.replace(/[0-9@$!]/g, ch => LEET[ch] || ch);
    return s;
  }
  const collapse = s => s.replace(/(.)\1+/gu, '$1');
  function wordIsBad(w, extra) {
    const n1 = normWord(w).replace(/[_@$!]/g, ''), n2 = collapse(n1);
    const lists = extra ? [BAD, extra] : [BAD];
    for (const list of lists) for (const re of list) if (re.test(n1) || re.test(n2)) return true;
    return false;
  }

  // ---------------------------------------------------------------- nickname / password
  function nicknameError(name) {
    if (typeof name !== 'string' || !name.length) return 'Введите ник';
    if (name.length < NICK_MIN || name.length > NICK_MAX) return `Ник должен быть от ${NICK_MIN} до ${NICK_MAX} символов`;
    if (!/^[A-Za-z0-9_]+$/.test(name)) return 'Ник может содержать только английские буквы (A–Z), цифры (0–9) и знак _';
    if ((name.match(/_/g) || []).length > 1) return 'В нике может быть только один знак _';
    if (name[0] === '_' || name[name.length - 1] === '_') return 'Ник не может начинаться или заканчиваться знаком _';
    if (isBadNickname(name)) return 'Этот ник недопустим. Пожалуйста, выберите другой.';
    return null;
  }
  function isBadNickname(name) {
    const lower = name.toLowerCase();
    const tokens = new Set([lower, lower.replace(/_/g, ''), lower.replace(/[_0-9]/g, '')]);
    for (const part of lower.split(/[_0-9]+/)) if (part) tokens.add(part);
    for (const part of lower.split('_')) if (part) tokens.add(part);
    for (const t of tokens) if (wordIsBad(t, BAD_NAME)) return true;
    return false;
  }
  function utf8Len(s) { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; }
  function passwordError(pw) {
    if (typeof pw !== 'string' || !pw.length) return 'Введите пароль';
    const len = Array.from(pw).length;
    if (len < PASS_MIN) return `Пароль должен быть не короче ${PASS_MIN} символов`;
    if (len > PASS_MAX) return `Пароль слишком длинный (максимум ${PASS_MAX} символа)`;
    if (utf8Len(pw) > PASS_MAX) return 'Пароль слишком длинный: максимум 72 байта (русские буквы занимают по 2)';
    if (/[\u0000-\u001F\u007F]/.test(pw)) return 'Пароль содержит недопустимые символы';
    return null;
  }

  // ---------------------------------------------------------------- chat sanitizer
  const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0E\uFEFF\uFFA0\uFFF0-\uFFFF]|[\u{E0000}-\u{E007F}]/gu;
  const TLDS = 'com|net|org|ru|рф|su|io|gg|me|tv|xyz|info|biz|co|uk|de|ua|by|kz|app|dev|site|online|store|shop|link|club|top|live|pro|fun|ly|to|cc|ws|us|eu|tk|ml|ga|cf|gq|be|page|chat|game|games|onion|lol|win|space|website|tech|cloud|host|bot|art';
  const NB = '(?<![\\p{L}\\p{N}_])', NA = '(?![\\p{L}\\p{N}_])';
  const RE_EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
  const RE_URL = /(?:https?|ftp|wss?|file):\/\/\S*/giu;
  const RE_WWW = /(?<![\p{L}\p{N}])www\.\S*/giu;
  const RE_IPV4 = new RegExp(NB + '\\d{1,3}(?:\\s?[.,:_\\-]\\s?\\d{1,3}){3}(?::\\d{1,5})?' + NA, 'gu');
  const RE_IPV6 = /(?<![\p{L}\p{N}:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\p{L}\p{N}:])/giu;
  const RE_DOMAIN = new RegExp(NB + '[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.(?:' + TLDS + ')' + NA + '(?:[/:?#]\\S*)?', 'giu');
  const RE_LONGNUM = /\d[\d\s()+-]{8,}\d/gu; // phone-like numbers

  function sanitizeChat(raw) {
    if (typeof raw !== 'string') return { error: 'Пустое сообщение' };
    if (raw.length > 600) return { error: `Сообщение длиннее ${CHAT_MAX} символов` };
    let s = raw.normalize('NFKC').replace(INVISIBLE, ' ');
    s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1');          // zalgo
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return { error: 'Пустое сообщение' };
    if (Array.from(s).length > CHAT_MAX) return { error: `Сообщение длиннее ${CHAT_MAX} символов` };
    let masked = false;
    const mask = (re, test) => { s = s.replace(re, m => { if (test && !test(m)) return m; masked = true; return '***'; }); };
    mask(RE_EMAIL);
    mask(RE_URL);
    mask(RE_WWW);
    mask(RE_IPV4);
    mask(RE_IPV6, m => m.includes('::') || /[a-f]/i.test(m) || (m.match(/:/g) || []).length >= 3);
    mask(RE_DOMAIN);
    mask(RE_LONGNUM, m => (m.match(/\d/g) || []).length >= 9);
    s = s.replace(/[\p{L}\p{N}_@$!]+/gu, w => { if (wordIsBad(w)) { masked = true; return '***'; } return w; });
    s = s.replace(/(.)\1{3,}/gsu, '$1$1$1');            // "aaaaaa" -> "aaa"
    s = s.replace(/(.{2,6}?)\1{3,}/gsu, '$1$1$1');      // "hahahahaha" -> "hahaha"
    s = s.replace(/(?:\*\*\*[\s*]*){2,}/g, '*** ').trim();
    if (!s) return { error: 'Пустое сообщение' };
    return { text: s, masked };
  }

  const api = { NICK_MIN, NICK_MAX, PASS_MIN, PASS_MAX, CHAT_MAX, nicknameError, passwordError, sanitizeChat, isBadNickname, wordIsBad };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RULES = api;
})(typeof window !== 'undefined' ? window : this);
