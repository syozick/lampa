(function () {
    'use strict';

    // 1. Додаємо пункт статусу автопошуку в Налаштування -> TorrServer
    if (window.Lampa && Lampa.SettingsApi) {
        Lampa.SettingsApi.addParam({
            component: 'torrserver',
            param: {
                name: 'torrserver_auto_status',
                type: 'static',
                default: 'Очікування...'
            },
            field: {
                name: 'Автопошук TorrServer',
                description: 'Статус локального сканування мережі'
            }
        });
    }

    function updateStatus(text, url) {
        Lampa.Storage.set('torrserver_auto_status', text);

        if (url) {
            Lampa.Storage.set('torrserver_url', url);
            Lampa.Storage.set('torrserver_url_two', url);
        }

        // Відображення тексту в розгорнутому меню
        var items = document.querySelectorAll('.settings-param');
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var textContent = item.textContent || '';
            
            if (url && textContent.indexOf('Основне посилання') !== -1) {
                var valMain = item.querySelector('.settings-param__value');
                if (valMain) valMain.textContent = url;
            }
            if (textContent.indexOf('Автопошук TorrServer') !== -1) {
                var valAuto = item.querySelector('.settings-param__value');
                if (valAuto) valAuto.textContent = text;
            }
        }
    }

    function scanLocalTorrServer() {
        var subnets = ['192.168.1.', '192.168.0.', '192.168.31.', '192.168.88.'];
        var port = '8090';
        var found = false;

        updateStatus('Йде пошук...', '');

        if (window.Lampa && Lampa.Noty) {
            Lampa.Noty.show('Розпочато автопошук локального TorrServer...');
        }

        var totalRequests = subnets.length * 253;
        var completedRequests = 0;

        subnets.forEach(function (subnet) {
            for (var i = 2; i <= 254; i++) {
                if (found) return;

                let testIP = subnet + i;
                let testUrl = 'http://' + testIP + ':' + port;

                let xhr = new XMLHttpRequest();
                xhr.open('GET', testUrl + '/echo', true);
                xhr.timeout = 1200;

                function checkCompletion() {
                    completedRequests++;
                    if (!found && completedRequests >= totalRequests) {
                        updateStatus('Не знайдено', '');
                        if (window.Lampa && Lampa.Noty) {
                            Lampa.Noty.show('TorrServer не знайдено в мережі');
                        }
                    }
                }

                xhr.onload = function () {
                    if (xhr.status === 200 && !found) {
                        found = true;
                        updateStatus(testUrl, testUrl);
                        if (window.Lampa && Lampa.Noty) {
                            Lampa.Noty.show('Знайдено TorrServer: ' + testUrl);
                        }
                    }
                    checkCompletion();
                };

                xhr.onerror = checkCompletion;
                xhr.ontimeout = checkCompletion;

                xhr.send();
            }
        });
    }

    function start() {
        setTimeout(scanLocalTorrServer, 500);
    }

    if (window.appready) {
        start();
    } else if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (e) {
            if (e.type == 'ready') start();
        });
    } else {
        setTimeout(start, 1000);
    }
})();
