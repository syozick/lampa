(function () {
    'use strict';

    /* ==========================================================
       Плагін автопошуку TorrServer у локальній мережі для LAMPA
       ========================================================== */

    var BASE_SUBNETS = ['192.168.1.', '192.168.0.', '192.168.31.', '192.168.88.'];
    var PORT = '8090';
    var CONCURRENCY = 12;
    var TIMEOUT_MS = 1500;
    var MAX_VALID_RESPONSE_LEN = 500;

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
        isOpen: false
    };

    /* ---------- Примусове переміщення пункту меню в самий верх ---------- */

    function moveComponentToTop() {
        var target = document.querySelector('.settings-folder[data-component="' + OWN_COMPONENT + '"]');
        if (target && target.parentNode) {
            var parent = target.parentNode;
            if (parent.firstChild !== target) {
                parent.insertBefore(target, parent.firstChild);
            }
        }
    }

    // Спостерігач за появою елементів у меню налаштувань
    function observeSettingsDOM() {
        var observer = new MutationObserver(function (mutations, obs) {
            var target = document.querySelector('.settings-folder[data-component="' + OWN_COMPONENT + '"]');
            if (target) {
                moveComponentToTop();
                obs.disconnect(); // Вимикаємо після успішного переміщення
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Застрахуємося додатковим таймером
        setTimeout(function () {
            moveComponentToTop();
            observer.disconnect();
        }, 1000);
    }

    /* ---------- Реєстрація в SettingsApi ---------- */

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
        } catch (e) {}

        Lampa.SettingsApi.addParam({
            component: OWN_COMPONENT,
            param: {
                name: 'torrserver_auto_status',
                type: 'title',
                default: STATUS_IDLE
            },
            field: {
                name: 'Статус пошуку',
                description: 'Поточний стан сканування'
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

    /* ---------- Робота зі статусом та DOM ---------- */

    function setStatus(text) {
        Lampa.Storage.set('torrserver_auto_status', text);
        updateStatusDOM(text);
    }

    function updateStatusDOM(text) {
        if (!ui.isOpen) return;

        var params = document.querySelectorAll('.settings-param');
        params.forEach(function (el) {
            var nameEl = el.querySelector('.settings-param__name');
            var valEl = el.querySelector('.settings-param__value') || el.querySelector('.settings-param__descr');
            if (!nameEl) return;

            var title = nameEl.innerText || nameEl.textContent || '';
            if (title.indexOf('Статус пошуку') !== -1) {
                if (valEl) valEl.textContent = text;
            }
        });
    }

    function saveFoundUrl(url) {
        Lampa.Storage.set('torrserver_url', url);
        Lampa.Storage.set('torrserver_url_two', url);
        Lampa.Storage.set('torrserver_use_link', 'one');
    }

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
            // Відкриваємо головні налаштування — запускаємо спостереження
            if (e.type === 'open' && !e.component) {
                observeSettingsDOM();
            }

            // Наш розділ
            if (e.component === OWN_COMPONENT) {
                if (e.type === 'open') {
                    ui.isOpen = true;
                    setTimeout(function () {
                        var currentStatus = Lampa.Storage.get('torrserver_auto_status', STATUS_IDLE);
                        updateStatusDOM(currentStatus);
                        bindDomFallback();
                    }, 100);
                } else if (e.type === 'close') {
                    ui.isOpen = false;
                }
            }
        });
    }

    /* ---------- Логіка сканування ---------- */

    function getAutoSubnet() {
        var subnets = BASE_SUBNETS.slice();
        try {
            var locationHost = window.location.hostname;
            if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(locationHost)) {
                var parts = locationHost.split('.');
                var detectedSubnet = parts[0] + '.' + parts[1] + '.' + parts[2] + '.';
                if (subnets.indexOf(detectedSubnet) === -1) {
                    subnets.unshift(detectedSubnet);
                }
            }
        } catch (e) {}
        return subnets;
    }

    function buildTargetList() {
        var list = [];
        var subnets = getAutoSubnet();
        subnets.forEach(function (subnet) {
            for (var i = 1; i <= 254; i++) {
                list.push(subnet + i);
            }
        });
        return list;
    }

    function abortActiveRequests() {
        state.activeXhrs.forEach(function (item) {
            if (item.timer) clearTimeout(item.timer);
            try { item.xhr.abort(); } catch (e) {}
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

        if (state.nextIndex >= state.total) return;

        var ip = state.targets[state.nextIndex++];
        var testUrl = 'http://' + ip + ':' + PORT;

        var xhr = new XMLHttpRequest();
        var requestItem = { xhr: xhr, timer: null };
        state.activeXhrs.push(requestItem);

        var isHandled = false;

        function onRequestDone(isSuccess) {
            if (isHandled) return;
            isHandled = true;

            if (requestItem.timer) clearTimeout(requestItem.timer);

            state.completed++;
            var idx = state.activeXhrs.indexOf(requestItem);
            if (idx !== -1) state.activeXhrs.splice(idx, 1);

            if (!state.scanning || state.found) return;

            if (isSuccess) {
                finishWithSuccess(testUrl);
                return;
            }

            setStatus(STATUS_SCANNING + ': ' + state.completed + ' з ' + state.total);

            if (state.nextIndex < state.total) {
                tryNextTarget();
            } else if (state.completed >= state.total) {
                finishWithNotFound();
            }
        }

        requestItem.timer = setTimeout(function () {
            try { xhr.abort(); } catch (e) {}
            onRequestDone(false);
        }, TIMEOUT_MS + 200);

        xhr.open('GET', testUrl + '/echo', true);
        xhr.timeout = TIMEOUT_MS;

        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                var isOk = (xhr.status === 200 && xhr.responseText && xhr.responseText.length <= MAX_VALID_RESPONSE_LEN) ||
                           (xhr.status === 0 && xhr.responseText && xhr.responseText.length > 0 && xhr.responseText.length <= MAX_VALID_RESPONSE_LEN);

                onRequestDone(isOk);
            }
        };

        xhr.onerror = function () { onRequestDone(false); };
        xhr.ontimeout = function () { onRequestDone(false); };

        try {
            xhr.send();
        } catch (e) {
            onRequestDone(false);
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

        setStatus(STATUS_SCANNING + ': 0 з ' + state.total);
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
