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

    var STATUS_IDLE = 'Очікування...';
    var STATUS_SCANNING = 'Йде пошук...';
    var STATUS_NOT_FOUND = 'Не знайдено';

    var state = {
        scanning: false,
        found: false,
        activeXhrs: [],
        targets: [],
        nextIndex: 0,
        completed: 0,
        total: 0
    };

    /* ---------- Реєстрація в SettingsApi ---------- */

    function registerSettings() {
        if (!(window.Lampa && Lampa.SettingsApi)) return;

        Lampa.SettingsApi.addParam({
            component: 'torrserver',
            param: {
                name: 'torrserver_auto_status',
                type: 'input',
                default: STATUS_IDLE
            },
            field: {
                name: 'Автопошук TorrServer',
                description: 'Поточний статус локального сканування мережі'
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'torrserver',
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
            component: 'torrserver',
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

    function setStatus(text) {
        Lampa.Storage.set('torrserver_auto_status', text);
        refreshUI();
    }

    function saveFoundUrl(url) {
        // Захист: ніколи не пишемо в torrserver_url нічого, крім
        // рядка, який сама ж функція scanLocalTorrServer сконструювала
        // як http://ip:port. Вміст відповіді сервера сюди не потрапляє.
        Lampa.Storage.set('torrserver_url', url);
        Lampa.Storage.set('torrserver_url_two', url);
    }

    function refreshUI() {
        if (window.Lampa && Lampa.Settings && typeof Lampa.Settings.update === 'function') {
            try {
                Lampa.Settings.update();
                return;
            } catch (e) {
                /* ідемо у DOM fallback нижче */
            }
        }
        updateMenuDOM();
    }

    function updateMenuDOM() {
        var statusText = Lampa.Storage.get('torrserver_auto_status', STATUS_IDLE);
        var params = document.querySelectorAll('.settings-param');

        params.forEach(function (el) {
            var nameEl = el.querySelector('.settings-param__name');
            var valEl = el.querySelector('.settings-param__value');
            if (!nameEl || !valEl) return;

            var title = nameEl.innerText || nameEl.textContent || '';
            if (title.indexOf('Автопошук TorrServer') !== -1) {
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
            if (e.type === 'open' && e.component === 'torrserver') {
                setTimeout(function () {
                    updateMenuDOM();
                    bindDomFallback();
                }, 150);
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
        setStatus(reasonText || STATUS_IDLE);
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Сканування зупинено');
    }

    function finishWithSuccess(url) {
        state.scanning = false;
        state.found = true;
        abortActiveRequests();
        saveFoundUrl(url);
        setStatus(url);
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Знайдено TorrServer: ' + url);
    }

    function finishWithNotFound() {
        state.scanning = false;
        setStatus(STATUS_NOT_FOUND);
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

            setStatus(STATUS_SCANNING + ' (' + state.completed + '/' + state.total + ')');

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

        setStatus(STATUS_SCANNING + ' (0/' + state.total + ')');
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
