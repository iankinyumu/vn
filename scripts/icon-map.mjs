// Font Awesome names the site used, mapped to Google Material Symbols (Outlined). Kept so the
// conversion is reviewable and so scripts/check-icons can verify every name Google serves.
export const ICON_MAP = Object.freeze({
    'angles-left': 'keyboard_double_arrow_left', 'angles-right': 'keyboard_double_arrow_right',
    'arrow-down': 'arrow_downward', 'arrow-left': 'arrow_back', 'arrow-right': 'arrow_forward', 'arrow-right-long': 'arrow_right_alt', 'arrow-up': 'arrow_upward',
    at: 'alternate_email', ban: 'block', bars: 'menu', 'bars-staggered': 'sort', bell: 'notifications', bolt: 'bolt', 'book-open': 'menu_book', bullhorn: 'campaign',
    'calendar-alt': 'calendar_month', 'chart-area': 'area_chart', 'chart-column': 'bar_chart', 'chart-line': 'show_chart', 'chart-pie': 'pie_chart', 'chart-simple': 'bar_chart',
    check: 'check', 'chevron-down': 'expand_more', 'chevron-left': 'chevron_left', 'chevron-right': 'chevron_right',
    circle: 'circle', 'circle-check': 'check_circle', 'circle-exclamation': 'error', 'circle-half-stroke': 'contrast', 'circle-info': 'info', 'circle-question': 'help', 'circle-xmark': 'cancel',
    clock: 'schedule', 'clock-rotate-left': 'history', cog: 'settings', cubes: 'category', dice: 'casino', envelope: 'mail', equals: 'equal', 'exchange-alt': 'swap_horiz',
    'exclamation-circle': 'error', 'exclamation-triangle': 'warning', eye: 'visibility', 'face-smile': 'mood', 'flag-checkered': 'sports_score', 'gauge-high': 'speed',
    hashtag: 'tag', headset: 'support_agent', history: 'history', 'hourglass-half': 'hourglass_top', house: 'home', inbox: 'inbox', key: 'key', 'layer-group': 'layers',
    list: 'list', 'list-ol': 'format_list_numbered', lock: 'lock', 'mobile-screen-button': 'smartphone', 'money-bill-transfer': 'currency_exchange', moon: 'dark_mode',
    'not-equal': 'difference', 'paper-plane': 'send', percent: 'percent', plus: 'add', qrcode: 'qr_code', redo: 'refresh', 'right-from-bracket': 'logout', save: 'save',
    'scale-balanced': 'balance', search: 'search', 'shield-alt': 'shield', 'shield-halved': 'shield', 'sign-in-alt': 'login', 'sign-out-alt': 'logout', 'sliders-h': 'tune',
    star: 'star', stopwatch: 'timer', sun: 'light_mode', table: 'table', times: 'close', undo: 'undo', 'unlock-alt': 'lock_open', upload: 'upload', user: 'person',
    'user-circle': 'account_circle', 'user-edit': 'edit', 'user-shield': 'admin_panel_settings', 'user-slash': 'person_off', users: 'group', 'wave-square': 'graphic_eq', xmark: 'close',
});

export const ICON_NAMES = [...new Set(Object.values(ICON_MAP))].sort();
// One request for exactly the icons in use; display=block hides glyphs briefly instead of flashing names.
export const ICON_FONT_URL = `https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&icon_names=${ICON_NAMES.join(',')}&display=block`;
