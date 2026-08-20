(function () {
    'use strict';

    /* ==========================================================
       Плагін автопошуку TorrServer у локальній мережі для LAMPA
       ========================================================== */

    var SUBNETS = ['192.168.1.', '192.168.0.', '192.168.31.', '192.168.88.'];
    var PORT = '8090';
    var CONCURRENCY = 16;      // скільки запитів тримаємо одночасно "в польоті"
    var TIMEOUT_MS = 1200;
    var MAX_VALID_RESPONSE_LEN = 500; // echo від TorrServer короткий; усе набагато довше — не він
    var UI_UPDATE_THROTTLE_MS = 500;  // не оновлювати екран частіше, ніж раз на цей інтервал

    var STATUS_IDLE = 'Очікування';
    var STATUS_SCANNING = 'Йде пошук';
    var STATUS_NOT_FOUND = 'Не знайдено';

    var OWN_COMPONENT = 'torrserver_autoscan';

    var state = {
        scanning: false,
        found: false,
        activeXhrs: [],
        targets: [],
        nextIndex: 0,
        completed: 0,
        total: 0
    };

    var ui = {
        isOpen: false,        // чи зараз відкритий наш розділ налаштувань
        lastUpdateAt: 0
    };

    /* ---------- Реєстрація в SettingsApi ---------- */

    // Назва компонента налаштувань TorrServer відрізняється між збірками LAMPA,
    // тому не вгадуємо її, а створюємо ВЛАСНИЙ розділ через addComponent —
    // він завжди буде окремим пунктом у списку налаштувань.
    function registerSettings() {
        if (!(window.Lampa && Lampa.SettingsApi)) return;

        try {
            if (typeof Lampa.SettingsApi.addComponent === 'function') {
                Lampa.SettingsApi.addComponent({
                    component: OWN_COMPONENT,
                    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 3" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
                    name: 'Автопошук TorrServer'
                });
            }
        } catch (e) {
            /* якщо addComponent недоступний у цій збірці - йдемо далі без нього */
        }

        Lampa.SettingsApi.addParam({
            component: OWN_COMPONENT,
            param: {
                name: 'torrserver_auto_status',
                type: 'input',
                default: STATUS_IDLE
            },
            field: {
                name: 'Статус пошуку',
                description: 'Поточний статус локального сканування мережі'
            }
        });

        Lampa.SettingsApi.addParam({
            component: OWN_COMPONENT,
            param: {
                name: 'torrserver_auto_rescan',
                type: 'button',
                default: ''
            },
            field: {
                name: 'Пересканувати мережу',
                description: 'Запустити пошук TorrServer вручну'
            },
            onChange: function () {
                startScan();
            }
        });

        Lampa.SettingsApi.addParam({
            component: OWN_COMPONENT,
            param: {
                name: 'torrserver_auto_stop',
                type: 'button',
                default: ''
            },
            field: {
                name: 'Зупинити сканування',
                description: 'Перервати поточний пошук'
            },
            onChange: function () {
                stopScan('Зупинено користувачем');
            }
        });
    }

    /* ---------- Робота зі статусом і сховищем ---------- */

    // Пишемо в Storage завжди (це дешево), а ось "живий" перерендер екрану -
    // тільки якщо розділ відкритий і не частіше UI_UPDATE_THROTTLE_MS.
    // Саме часті виклики Lampa.Settings.update() під час активного сканування
    // (до 1000+ разів за прохід) і призводили до краху в app.min.js.
    function setStatus(text, forceRender) {
        Lampa.Storage.set('torrserver_auto_status', text);

        if (!ui.isOpen && !forceRender) return;

        var now = Date.now();
        if (!forceRender && (now - ui.lastUpdateAt) < UI_UPDATE_THROTTLE_MS) return;

        ui.lastUpdateAt = now;
        refreshUI();
    }

    function saveFoundUrl(url) {
        // Ніколи не пишемо в torrserver_url нічого, крім рядка, який сама ж
        // функція tryNextTarget сконструювала як http://ip:port.
        // Вміст відповіді сервера (responseText) сюди ніколи не потрапляє.
        Lampa.Storage.set('torrserver_url', url);
        Lampa.Storage.set('torrserver_url_two', url);
    }

    function refreshUI() {
        if (window.Lampa && Lampa.Settings && typeof Lampa.Settings.update === 'function') {
            try {
                Lampa.Settings.update();
                return;
            } catch (e) {
                /* якщо впало всередині самого LAMPA - тихо йдемо у DOM fallback,
                   щоб не ронити наш плагін через їхній рендер */
            }
        }
        try {
            updateMenuDOM();
        } catch (e) {
            /* ігноруємо помилки рендеру - на роботу сканування це не впливає */
        }
    }

    function updateMenuDOM() {
        var statusText = Lampa.Storage.get('torrserver_auto_status', STATUS_IDLE);
        var params = document.querySelectorAll('.settings-param');

        params.forEach(function (el) {
            var nameEl = el.querySelector('.settings-param__name');
            var valEl = el.querySelector('.settings-param__value');
            if (!nameEl || !valEl) return;

            var title = nameEl.innerText || nameEl.textContent || '';
            if (title.indexOf('Статус пошуку') !== -1) {
                valEl.textContent = statusText;
            }
        });
    }

    /* ---------- Клік по кнопках через DOM (fallback) ---------- */

    function bindDomFallback() {
        var params = document.querySelectorAll('.settings-param');
        params.forEach(function (el) {
            var nameEl = el.querySelector('.settings-param__name');
            if (!nameEl || el.dataset.autoscanBound) return;

            var title = nameEl.innerText || nameEl.textContent || '';

            if (title.indexOf('Пересканувати мережу') !== -1) {
                el.dataset.autoscanBound = '1';
                el.addEventListener('click', function () { startScan(); });
            } else if (title.indexOf('Зупинити сканування') !== -1) {
                el.dataset.autoscanBound = '1';
                el.addEventListener('click', function () { stopScan('Зупинено користувачем'); });
            }
        });
    }

    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('settings', function (e) {
            if (e.component !== OWN_COMPONENT) return;

            if (e.type === 'open') {
                ui.isOpen = true;
                setTimeout(function () {
                    updateMenuDOM();
                    bindDomFallback();
                }, 150);
            } else if (e.type === 'close') {
                ui.isOpen = false;
            }
        });
    }

    /* ---------- Логіка сканування ---------- */

    function buildTargetList() {
        var list = [];
        SUBNETS.forEach(function (subnet) {
            for (var i = 2; i <= 254; i++) {
                list.push(subnet + i);
            }
        });
        return list;
    }

    function looksLikeValidTorrServerResponse(text) {
        if (typeof text !== 'string') return false;
        if (text.length === 0 || text.length > MAX_VALID_RESPONSE_LEN) return false;
        return true;
    }

    function abortActiveRequests() {
        state.activeXhrs.forEach(function (xhr) {
            try { xhr.abort(); } catch (e) { /* ігноруємо */ }
        });
        state.activeXhrs = [];
    }

    function stopScan(reasonText) {
        if (!state.scanning) return;
        state.scanning = false;
        abortActiveRequests();
        setStatus(reasonText || STATUS_IDLE, true);
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Сканування зупинено');
    }

    function finishWithSuccess(url) {
        state.scanning = false;
        state.found = true;
        abortActiveRequests();
        saveFoundUrl(url);
        setStatus(url, true); // forceRender: фінальний стан показуємо одразу
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Знайдено TorrServer: ' + url);
    }

    function finishWithNotFound() {
        state.scanning = false;
        setStatus(STATUS_NOT_FOUND, true);
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('TorrServer не знайдено в мережі');
    }

    function tryNextTarget() {
        if (!state.scanning || state.found) return;

        if (state.nextIndex >= state.total) {
            return; // адреси закінчились - чекаємо, доки активні запити доопрацюють
        }

        var ip = state.targets[state.nextIndex++];
        var testUrl = 'http://' + ip + ':' + PORT;

        var xhr = new XMLHttpRequest();
        state.activeXhrs.push(xhr);
        xhr.open('GET', testUrl + '/echo', true);
        xhr.timeout = TIMEOUT_MS;

        function onRequestDone() {
            state.completed++;
            var idx = state.activeXhrs.indexOf(xhr);
            if (idx !== -1) state.activeXhrs.splice(idx, 1);

            if (!state.scanning || state.found) return;

            // Прогрес пишемо в Storage завжди, а рендер - через троттлінг у setStatus
            setStatus(STATUS_SCANNING + ': ' + state.completed + ' з ' + state.total);

            if (state.nextIndex < state.total) {
                tryNextTarget();
            } else if (state.completed >= state.total) {
                finishWithNotFound();
            }
        }

        xhr.onload = function () {
            var ok = (xhr.status === 200 || xhr.status === 0) &&
                     looksLikeValidTorrServerResponse(xhr.responseText);

            if (ok && !state.found) {
                finishWithSuccess(testUrl); // зберігаємо саме testUrl, не responseText
            } else {
                onRequestDone();
            }
        };

        xhr.onerror = onRequestDone;
        xhr.ontimeout = onRequestDone;

        try {
            xhr.send();
        } catch (e) {
            onRequestDone();
        }
    }

    function startScan() {
        if (state.scanning) {
            if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Сканування вже триває...');
            return;
        }

        state.scanning = true;
        state.found = false;
        state.activeXhrs = [];
        state.targets = buildTargetList();
        state.nextIndex = 0;
        state.completed = 0;
        state.total = state.targets.length;

        setStatus(STATUS_SCANNING + ': 0 з ' + state.total, true);
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Розпочато пошук TorrServer...');

        var starters = Math.min(CONCURRENCY, state.total);
        for (var i = 0; i < starters; i++) {
            tryNextTarget();
        }
    }

    /* ---------- Старт плагіна ---------- */

    function init() {
        registerSettings();
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Плагін автопошуку TorrServer завантажено!');
        setTimeout(startScan, 1000);
    }

    if (window.appready) {
        init();
    } else if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') init();
        });
    } else {
        setTimeout(init, 1500);
    }
})();
