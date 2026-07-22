(function () {
    'use strict';

    // 1. Реєструємо параметр у SettingsApi
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
    }

    // Запис у пам'ять та оновлення DOM
    function setStatus(statusText, foundUrl) {
        Lampa.Storage.set('torrserver_auto_status', statusText);

        if (foundUrl) {
            Lampa.Storage.set('torrserver_url', foundUrl);
            Lampa.Storage.set('torrserver_url_two', foundUrl);
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

    // При кожному відкритті меню налаштувань оновлюємо значення на екрані
    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('settings', function (e) {
            if (e.type === 'open' && e.component === 'torrserver') {
                setTimeout(function () {
                    var currentStatus = Lampa.Storage.get('torrserver_auto_status', 'Очікування...');
                    var currentUrl = Lampa.Storage.get('torrserver_url', '');
                    updateMenuDOM(currentStatus, currentUrl);
                }, 100);
            }
        });
    }

    function scanLocalTorrServer() {
        var subnets = ['192.168.1.', '192.168.0.', '192.168.31.', '192.168.88.'];
        var port = '8090';
        var found = false;

        setStatus('Йде пошук...', '');
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Розпочато автопошук TorrServer...');

        var totalRequests = subnets.length * 253;
        var completedRequests = 0;

        subnets.forEach(function (subnet) {
            for (var i = 2; i <= 254; i++) {
                if (found) return;

                let testIP = subnet + i;
                let testUrl = 'http://' + testIP + ':' + port;

                let xhr = new XMLHttpRequest();
                xhr.open('GET', testUrl + '/echo', true);
                xhr.timeout = 1500;

                function checkCompletion() {
                    completedRequests++;
                    if (!found && completedRequests >= totalRequests) {
                        setStatus('Не знайдено', '');
                        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('TorrServer не знайдено в мережі');
                    }
                }

                xhr.onload = function () {
                    if ((xhr.status === 200 || xhr.status === 0) && !found && xhr.responseText) {
                        found = true;
                        setStatus(testUrl, testUrl);
                        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Знайдено TorrServer: ' + testUrl);
                    } else {
                        checkCompletion();
                    }
                };

                xhr.onerror = checkCompletion;
                xhr.ontimeout = checkCompletion;

                try { xhr.send(); } catch (e) { checkCompletion(); }
            }
        });
    }

    function start() {
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Плагін автопошуку завантажено!');
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
