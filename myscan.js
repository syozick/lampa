(function () {
    'use strict';

    var SUBNETS = ['192.168.1.', '192.168.0.', '192.168.31.', '192.168.88.'];
    var PORT = '8090';
    var CONCURRENCY = 16;   // скільки запитів тримаємо одночасно "в польоті"
    var TIMEOUT_MS = 1200;

    var scanning = false;
    var activeXhrs = [];

    // 1. Реєструємо параметри у SettingsApi
    if (window.Lampa && Lampa.SettingsApi) {
        Lampa.SettingsApi.addParam({
            component: 'torrserver',
            param: {
                name: 'torrserver_auto_status',
                type: 'input',
                default: 'Очікування...'
            },
            field: {
                name: 'Автопошук TorrServer',
                description: 'Статус локального сканування мережі'
            }
        });

        // Кнопка ручного пересканування.
        // Тип 'button' підтримується не в усіх форках LAMPA — тому нижче
        // ще й DOM fallback на клік по цьому пункту меню.
        Lampa.SettingsApi.addParam({
            component: 'torrserver',
            param: {
                name: 'torrserver_auto_rescan',
                type: 'button',
                default: ''
            },
            field: {
                name: 'Пересканувати мережу',
                description: 'Натисніть, щоб запустити пошук TorrServer вручну'
            },
            onChange: function () {
                scanLocalTorrServer();
            }
        });
    }

    function setStatus(statusText, foundUrl) {
        Lampa.Storage.set('torrserver_auto_status', statusText);

        if (foundUrl) {
            Lampa.Storage.set('torrserver_url', foundUrl);
            Lampa.Storage.set('torrserver_url_two', foundUrl);
        }

        refreshSettingsUI(statusText, foundUrl);
    }

    function refreshSettingsUI(statusText, foundUrl) {
        if (window.Lampa && Lampa.Settings && typeof Lampa.Settings.update === 'function') {
            try {
                Lampa.Settings.update();
                return;
            } catch (e) {
                // якщо офіційний метод недоступний/впав - йдемо у fallback нижче
            }
        }
        updateMenuDOM(statusText, foundUrl);
    }

    function updateMenuDOM(statusText, foundUrl) {
        var params = document.querySelectorAll('.settings-param');
        params.forEach(function (el) {
            var nameEl = el.querySelector('.settings-param__name');
            var valEl = el.querySelector('.settings-param__value');

            if (nameEl && valEl) {
                var title = nameEl.innerText || nameEl.textContent || '';

                if (title.indexOf('Автопошук TorrServer') !== -1) {
                    valEl.textContent = statusText;
                }
                if (foundUrl && title.indexOf('Основне посилання') !== -1) {
                    valEl.textContent = foundUrl;
                }
            }
        });
    }

    // Оновлення значень при кожному відкритті вкладки налаштувань
    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('settings', function (e) {
            if (e.type === 'open' && e.component === 'torrserver') {
                setTimeout(function () {
                    var currentStatus = Lampa.Storage.get('torrserver_auto_status', 'Очікування...');
                    var currentUrl = Lampa.Storage.get('torrserver_url', '');
                    updateMenuDOM(currentStatus, currentUrl);
                }, 100);

                // Fallback: клік по пункту "Пересканувати мережу" прямо в DOM,
                // на випадок якщо type:'button' + onChange не спрацював у вашій збірці.
                setTimeout(bindRescanClickFallback, 150);
            }
        });
    }

    function bindRescanClickFallback() {
        var params = document.querySelectorAll('.settings-param');
        params.forEach(function (el) {
            var nameEl = el.querySelector('.settings-param__name');
            if (!nameEl) return;

            var title = nameEl.innerText || nameEl.textContent || '';
            if (title.indexOf('Пересканувати мережу') !== -1 && !el.dataset.rescanBound) {
                el.dataset.rescanBound = '1';
                el.addEventListener('click', function () {
                    scanLocalTorrServer();
                });
            }
        });
    }

    function abortAll() {
        activeXhrs.forEach(function (xhr) {
            try { xhr.abort(); } catch (e) {}
        });
        activeXhrs = [];
    }

    function scanLocalTorrServer() {
        if (scanning) {
            if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Сканування вже триває...');
            return;
        }

        scanning = true;
        var found = false;

        var targets = [];
        SUBNETS.forEach(function (subnet) {
            for (var i = 2; i <= 254; i++) {
                targets.push(subnet + i);
            }
        });

        var total = targets.length;
        var completed = 0;
        var nextIndex = 0;

        setStatus('Йде пошук... (0/' + total + ')', '');
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Розпочато пошук TorrServer...');

        function finishScan(statusText, foundUrl) {
            scanning = false;
            abortAll();
            setStatus(statusText, foundUrl);
        }

        function runNext() {
            if (found) return;

            if (nextIndex >= total) {
                return; // адреси закінчились, чекаємо доки активні запити доопрацюють
            }

            var testIP = targets[nextIndex++];
            var testUrl = 'http://' + testIP + ':' + PORT;

            var xhr = new XMLHttpRequest();
            activeXhrs.push(xhr);
            xhr.open('GET', testUrl + '/echo', true);
            xhr.timeout = TIMEOUT_MS;

            function onDone() {
                completed++;
                var idx = activeXhrs.indexOf(xhr);
                if (idx !== -1) activeXhrs.splice(idx, 1);

                if (!found) {
                    setStatus('Йде пошук... (' + completed + '/' + total + ')', '');

                    if (nextIndex < total) {
                        runNext();
                    } else if (completed >= total) {
                        finishScan('Не знайдено', '');
                        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('TorrServer не знайдено в мережі');
                    }
                }
            }

            xhr.onload = function () {
                if (!found && (xhr.status === 200 || xhr.status === 0) && xhr.responseText) {
                    found = true;
                    if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Знайдено TorrServer: ' + testUrl);
                    finishScan(testUrl, testUrl);
                } else {
                    onDone();
                }
            };

            xhr.onerror = onDone;
            xhr.ontimeout = onDone;

            try {
                xhr.send();
            } catch (e) {
                onDone();
            }
        }

        var starters = Math.min(CONCURRENCY, total);
        for (var s = 0; s < starters; s++) {
            runNext();
        }
    }

    function start() {
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Плагін автопошуку TorrServer завантажено!');
        setTimeout(scanLocalTorrServer, 1000);
    }

    if (window.appready) {
        start();
    } else if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
    } else {
        setTimeout(start, 1500);
    }
})();
