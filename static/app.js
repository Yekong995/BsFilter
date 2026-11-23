/* ==========================================================================
   书源处理 · 页面交互
   1. 明暗主题切换（本地记忆 + 跟随系统）
   2. 拖拽 / 点击上传书源 JSON（XHR 进度、状态切换）
   3. 组别勾选（数据来自 /api/upload）
   4. 动态拉取并渲染当前勾选的书源（/api/sources）
   5. 保存当前筛选结果（POST /api/save，下载 JSON）
   ========================================================================== */

(function () {
    'use strict';

    var THEME_KEY = 'booksource-theme';
    var MAX_FILE_BYTES = 32 * 1024 * 1024; // 与后端 MAX_CONTENT_LENGTH 保持一致
    var CHECK_SVG =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';

    /* ---------- DOM ---------- */
    var dom = {
        root: document.documentElement,
        themeToggle: document.getElementById('theme-toggle'),
        dropzone: document.getElementById('dropzone'),
        fileInput: document.getElementById('file-input'),
        views: {},
        uploadName: document.querySelector('[data-upload-name]'),
        progress: document.getElementById('upload-progress'),
        progressBar: document.querySelector('[data-progress]'),
        progressText: document.querySelector('[data-progress-text]'),
        fileName: document.querySelector('[data-file-name]'),
        fileMeta: document.querySelector('[data-file-meta]'),
        errorText: document.querySelector('[data-error-text]'),
        btnReselect: document.getElementById('btn-reselect'),
        btnRetry: document.getElementById('btn-retry'),
        groupsCard: document.getElementById('groups-card'),
        groupsDesc: document.getElementById('groups-desc'),
        groupList: document.getElementById('group-list'),
        btnSelectAll: document.getElementById('btn-select-all'),
        btnClear: document.getElementById('btn-clear'),
        sourcesCard: document.getElementById('sources-card'),
        sourcesDesc: document.getElementById('sources-desc'),
        sourcesCount: document.getElementById('sources-count'),
        sourcesEmpty: document.getElementById('sources-empty'),
        emptyTitle: document.getElementById('empty-title'),
        emptyDesc: document.getElementById('empty-desc'),
        btnSourcesRetry: document.getElementById('btn-sources-retry'),
        sourcesLoading: document.getElementById('sources-loading'),
        sourcesScroll: document.getElementById('sources-scroll'),
        sourceList: document.getElementById('source-list'),
        sourcesFoot: document.getElementById('sources-foot'),
        btnSave: document.getElementById('btn-save'),
        saveLabel: document.querySelector('[data-save-label]'),
        toast: document.getElementById('toast'),
        toastText: document.querySelector('[data-toast-text]')
    };

    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (element) {
        dom.views[element.getAttribute('data-view')] = element;
    });

    /* ---------- 状态 ---------- */
    var state = {
        uploadId: null,
        groups: [],
        selected: new Set(),
        total: 0,
        requestSeq: 0,
        controller: null,
        debounceTimer: null,
        xhr: null,
        saving: false
    };

    /* =====================================================================
       主题
       ===================================================================== */

    var themeColorMeta = null;

    function ensureThemeColorMeta() {
        if (themeColorMeta) return themeColorMeta;
        themeColorMeta = document.querySelector('meta[name="theme-color"]');
        if (!themeColorMeta) {
            themeColorMeta = document.createElement('meta');
            themeColorMeta.setAttribute('name', 'theme-color');
            document.head.appendChild(themeColorMeta);
        }
        return themeColorMeta;
    }

    function applyTheme(theme) {
        var isDark = theme === 'dark';
        dom.root.setAttribute('data-theme', isDark ? 'dark' : 'light');
        dom.themeToggle.setAttribute('aria-label', isDark ? '切换到浅色模式' : '切换到深色模式');
        dom.themeToggle.setAttribute('title', isDark ? '切换到浅色模式' : '切换到深色模式');
        ensureThemeColorMeta().setAttribute('content', isDark ? '#08080a' : '#f4f4f6');
    }

    function persistTheme(theme) {
        try {
            localStorage.setItem(THEME_KEY, theme);
        } catch (error) {
            /* 隐私模式下 localStorage 可能不可用，忽略即可 */
        }
    }

    function initTheme() {
        applyTheme(dom.root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

        var media = window.matchMedia('(prefers-color-scheme: dark)');
        var onSystemChange = function (event) {
            var saved = null;
            try {
                saved = localStorage.getItem(THEME_KEY);
            } catch (error) {
                saved = null;
            }
            if (!saved) applyTheme(event.matches ? 'dark' : 'light');
        };

        if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', onSystemChange);
        } else if (typeof media.addListener === 'function') {
            media.addListener(onSystemChange);
        }
    }

    dom.themeToggle.addEventListener('click', function () {
        var next = dom.root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        persistTheme(next);
    });

    /* =====================================================================
       格式化工具
       ===================================================================== */

    function formatNumber(value) {
        var number = Number(value);
        if (!Number.isFinite(number)) return '0';
        return number.toLocaleString('zh-CN');
    }

    function formatBytes(bytes) {
        var size = Number(bytes);
        if (!Number.isFinite(size) || size <= 0) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB'];
        var index = 0;
        var value = size;
        while (value >= 1024 && index < units.length - 1) {
            value /= 1024;
            index += 1;
        }
        var text = index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1);
        return text + ' ' + units[index];
    }

    function displayUrl(raw) {
        var text = String(raw == null ? '' : raw).trim();
        if (!text) return '';
        try {
            return new URL(text).host;
        } catch (error) {
            return text.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        }
    }

    /* =====================================================================
       上传流程
       ===================================================================== */

    function setUploadView(view) {
        Object.keys(dom.views).forEach(function (name) {
            dom.views[name].hidden = name !== view;
        });
        dom.dropzone.setAttribute('data-state', view);
        dom.fileInput.tabIndex = view === 'idle' ? 0 : -1;
    }

    function setProgress(value) {
        var percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
        dom.progressBar.style.width = percent + '%';
        dom.progressText.textContent = percent + '%';
        dom.progress.setAttribute('aria-valuenow', String(percent));
    }

    function validateFile(file) {
        if (!file) return '没有读取到文件，请重新选择。';
        if (file.size === 0) return '文件是空的，请重新选择。';
        if (file.size > MAX_FILE_BYTES) return '文件超过 32 MB 限制，请精简后再上传。';
        var name = file.name || '';
        var looksJson = /\.json$/i.test(name) || /json/i.test(file.type || '');
        if (!looksJson) return '只支持 .json 书源文件，请选择正确的文件。';
        return '';
    }

    function resetWorkspace() {
        state.uploadId = null;
        state.groups = [];
        state.selected.clear();
        state.total = 0;
        state.requestSeq += 1;

        if (state.controller) {
            state.controller.abort();
            state.controller = null;
        }
        window.clearTimeout(state.debounceTimer);

        dom.groupsCard.hidden = true;
        dom.sourcesCard.hidden = true;
        dom.groupList.replaceChildren();
        dom.sourceList.replaceChildren();
        dom.sourcesFoot.hidden = true;
        dom.sourcesCount.hidden = true;
        dom.sourcesCount.textContent = '0 个';

        state.saving = false;
        window.clearTimeout(saveLabelTimer);
        setSaveLabel('保存筛选结果');
        updateSaveButton();
    }

    function handleFile(file) {
        var message = validateFile(file);
        if (message) {
            resetWorkspace();
            showUploadError(message);
            return;
        }
        uploadFile(file);
    }

    function uploadFile(file) {
        resetWorkspace();
        setUploadView('uploading');
        dom.uploadName.textContent = file.name || '文件';
        setProgress(0);

        if (state.xhr) state.xhr.abort();

        var form = new FormData();
        form.append('file', file);

        var xhr = new XMLHttpRequest();
        state.xhr = xhr;
        xhr.open('POST', '/api/upload');
        xhr.responseType = 'json';
        xhr.timeout = 60000;

        xhr.upload.addEventListener('progress', function (event) {
            if (xhr !== state.xhr) return;
            if (event.lengthComputable && event.total > 0) {
                setProgress((event.loaded / event.total) * 100);
            }
        });

        xhr.addEventListener('load', function () {
            if (xhr !== state.xhr) return;
            state.xhr = null;
            var payload = xhr.response && typeof xhr.response === 'object' ? xhr.response : {};
            if (xhr.status >= 200 && xhr.status < 300) {
                onUploadSuccess(file, payload);
            } else {
                showUploadError(payload.error || '上传失败（HTTP ' + xhr.status + '），请重试。');
            }
        });

        xhr.addEventListener('error', function () {
            if (xhr !== state.xhr) return;
            state.xhr = null;
            showUploadError('网络连接失败，请确认 Flask 服务正在运行。');
        });

        xhr.addEventListener('timeout', function () {
            if (xhr !== state.xhr) return;
            state.xhr = null;
            showUploadError('上传超时，请重新选择文件。');
        });

        xhr.send(form);
    }

    function showUploadError(message) {
        dom.errorText.textContent = message || '请检查文件后重试。';
        setUploadView('error');
    }

    function onUploadSuccess(file, payload) {
        if (!payload.upload_id || !Array.isArray(payload.groups)) {
            showUploadError('服务端返回的数据不完整，请重试。');
            return;
        }

        state.uploadId = payload.upload_id;
        state.groups = payload.groups.filter(function (group) {
            return group && typeof group.name === 'string' && group.name;
        });
        state.selected.clear();
        state.total = 0;

        setProgress(100);
        dom.fileName.textContent = payload.filename || file.name;
        dom.fileName.title = dom.fileName.textContent;
        dom.fileMeta.textContent = [
            '已解析 ' + formatNumber(payload.source_count) + ' 个书源',
            state.groups.length + ' 个组别',
            formatBytes(payload.size != null ? payload.size : file.size)
        ].join(' · ');

        setUploadView('success');
        renderGroups();
        updateGroupSummary();
        updateSaveButton();

        dom.groupsCard.hidden = false;
        dom.sourcesCard.hidden = false;
        refreshSources();
    }

    /* =====================================================================
       文件选择 / 拖拽
       ===================================================================== */

    dom.fileInput.addEventListener('change', function () {
        var file = dom.fileInput.files && dom.fileInput.files[0];
        dom.fileInput.value = ''; // 允许连续选择同一个文件
        if (file) handleFile(file);
    });

    [dom.btnReselect, dom.btnRetry].forEach(function (button) {
        button.addEventListener('click', function () {
            dom.fileInput.click();
        });
    });

    ['dragenter', 'dragover'].forEach(function (type) {
        dom.dropzone.addEventListener(type, function (event) {
            event.preventDefault();
            event.stopPropagation();
            dom.dropzone.classList.add('is-dragover');
        });
    });

    dom.dropzone.addEventListener('dragleave', function (event) {
        if (!dom.dropzone.contains(event.relatedTarget)) {
            dom.dropzone.classList.remove('is-dragover');
        }
    });

    dom.dropzone.addEventListener('drop', function (event) {
        event.preventDefault();
        event.stopPropagation();
        dom.dropzone.classList.remove('is-dragover');
        var files = event.dataTransfer && event.dataTransfer.files;
        var file = files && files[0];
        if (file) handleFile(file);
    });

    // 防止文件被拖到页面其他位置时浏览器直接打开它
    window.addEventListener('dragover', function (event) {
        event.preventDefault();
    });
    window.addEventListener('drop', function (event) {
        event.preventDefault();
    });

    /* =====================================================================
       组别
       ===================================================================== */

    function renderGroups() {
        var fragment = document.createDocumentFragment();

        state.groups.forEach(function (group) {
            var label = document.createElement('label');
            label.className = 'group-pill';
            label.setAttribute('data-group', group.name);

            var input = document.createElement('input');
            input.type = 'checkbox';
            input.value = group.name;
            input.setAttribute('aria-label', group.name + '，' + formatNumber(group.count) + ' 个书源');

            var check = document.createElement('span');
            check.className = 'pill-check';
            check.setAttribute('aria-hidden', 'true');
            check.innerHTML = CHECK_SVG;

            var name = document.createElement('span');
            name.className = 'pill-name';
            name.textContent = group.name;

            var count = document.createElement('span');
            count.className = 'pill-count';
            count.textContent = formatNumber(group.count);
            count.title = formatNumber(group.count) + ' 个书源';

            label.append(input, check, name, count);

            input.addEventListener('change', function () {
                label.classList.toggle('is-checked', input.checked);
                if (input.checked) {
                    state.selected.add(group.name);
                } else {
                    state.selected.delete(group.name);
                }
                scheduleSourcesRefresh();
            });

            fragment.appendChild(label);
        });

        dom.groupList.replaceChildren(fragment);
    }

    function updateGroupSummary() {
        var total = state.groups.length;
        if (!total) return;
        var selected = state.selected.size;
        dom.groupsDesc.textContent = selected
            ? '已选 ' + selected + ' / ' + total + ' 个组别，下方实时刷新。'
            : '共 ' + total + ' 个组别，勾选后下方实时刷新。';
    }

    function setAllGroups(checked) {
        if (!state.groups.length) return;

        state.selected.clear();
        if (checked) {
            state.groups.forEach(function (group) {
                state.selected.add(group.name);
            });
        }

        Array.prototype.forEach.call(dom.groupList.querySelectorAll('.group-pill'), function (pill) {
            var input = pill.querySelector('input');
            if (!input) return;
            input.checked = checked;
            pill.classList.toggle('is-checked', checked);
        });

        scheduleSourcesRefresh();
    }

    dom.btnSelectAll.addEventListener('click', function () {
        setAllGroups(true);
    });

    dom.btnClear.addEventListener('click', function () {
        setAllGroups(false);
    });

    /* =====================================================================
       当前勾选的书源
       ===================================================================== */

    function scheduleSourcesRefresh() {
        updateGroupSummary();
        updateSaveButton();
        window.clearTimeout(state.debounceTimer);
        state.debounceTimer = window.setTimeout(refreshSources, 120);
    }

    function setSourcesState(mode) {
        dom.sourcesEmpty.hidden = mode !== 'empty' && mode !== 'error';
        dom.sourcesLoading.hidden = mode !== 'loading';
        dom.sourcesScroll.hidden = mode !== 'list';
        dom.btnSourcesRetry.hidden = mode !== 'error';
    }

    async function refreshSources() {
        if (!state.uploadId) return;

        var selected = Array.from(state.selected);
        updateGroupSummary();

        if (!selected.length) {
            state.total = 0;
            dom.sourcesCount.hidden = true;
            dom.sourcesCount.textContent = '0 个';
            dom.emptyTitle.textContent = '还没有勾选书源';
            dom.emptyDesc.textContent = '在上方选择书源组别，结果会在这里实时更新。';
            dom.sourcesDesc.textContent = '勾选上方组别后，这里会展示对应的书源。';
            setSourcesState('empty');
            updateSaveButton();
            return;
        }

        setSourcesState('loading');
        dom.sourcesDesc.textContent = '正在加载书源…';

        var seq = ++state.requestSeq;
        if (state.controller) state.controller.abort();
        var controller = new AbortController();
        state.controller = controller;

        try {
            var response = await fetch('/api/sources', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ upload_id: state.uploadId, groups: selected }),
                signal: controller.signal
            });
            var payload = await response.json().catch(function () {
                return {};
            });

            if (seq !== state.requestSeq) return;
            if (!response.ok) {
                throw new Error(payload.error || '获取书源失败（HTTP ' + response.status + '）');
            }

            renderSources(payload, selected.length);
        } catch (error) {
            if (error.name === 'AbortError' || seq !== state.requestSeq) return;

            dom.emptyTitle.textContent = '加载失败';
            dom.emptyDesc.textContent = error.message || '请稍后重试。';
            dom.sourcesCount.hidden = true;
            dom.sourcesDesc.textContent = '获取书源时出现问题';
            setSourcesState('error');
        } finally {
            if (seq === state.requestSeq) state.controller = null;
        }
    }

    function renderSources(payload, selectedCount) {
        var sources = Array.isArray(payload.sources) ? payload.sources : [];
        var totalNumber = Number(payload.total);
        var total = Number.isFinite(totalNumber) ? totalNumber : sources.length;
        state.total = total;

        if (total === 0) {
            dom.sourcesCount.hidden = true;
            dom.emptyTitle.textContent = '没有匹配的书源';
            dom.emptyDesc.textContent = '试试其他组别，或重新上传包含目标组别的书源文件。';
            dom.sourcesDesc.textContent = '已选 ' + selectedCount + ' 个组别 · 没有匹配的书源';
            setSourcesState('empty');
            return;
        }

        var fragment = document.createDocumentFragment();
        sources.forEach(function (item) {
            fragment.appendChild(buildSourceItem(item));
        });
        dom.sourceList.replaceChildren(fragment);

        dom.sourcesFoot.hidden = false;
        dom.sourcesFoot.textContent = payload.truncated
            ? '已显示前 ' + formatNumber(sources.length) + ' 条，共 ' + formatNumber(total) + ' 条书源'
            : '共 ' + formatNumber(total) + ' 条书源';

        dom.sourcesCount.hidden = false;
        dom.sourcesCount.textContent = formatNumber(total) + ' 个';
        dom.sourcesDesc.textContent =
            '已选 ' + selectedCount + ' 个组别 · 匹配 ' + formatNumber(total) + ' 个书源';
        setSourcesState('list');
    }

    function buildSourceItem(item) {
        var row = document.createElement('li');
        row.className = 'source-item';

        var status = document.createElement('span');
        status.className = 'source-status' + (item.enabled === false ? ' is-off' : '');
        status.title = item.enabled === false ? '已停用' : '已启用';
        status.setAttribute('aria-hidden', 'true');

        var main = document.createElement('div');
        main.className = 'source-main';

        var name = document.createElement('span');
        name.className = 'source-name';
        name.textContent = item.name || '未命名书源';
        name.title = name.textContent;
        main.appendChild(name);

        var urlText = displayUrl(item.url);
        if (urlText) {
            var url = document.createElement('span');
            url.className = 'source-url';
            url.textContent = urlText;
            url.title = String(item.url || '');
            main.appendChild(url);
        }

        var groups = Array.isArray(item.groups) ? item.groups : [];
        var tags = null;
        if (groups.length) {
            tags = document.createElement('div');
            tags.className = 'source-tags';
            groups.slice(0, 2).forEach(function (groupName) {
                var tag = document.createElement('span');
                tag.className = 'tag';
                tag.textContent = groupName;
                tags.appendChild(tag);
            });
            if (groups.length > 2) {
                var more = document.createElement('span');
                more.className = 'tag';
                more.textContent = '+' + (groups.length - 2);
                more.title = groups.slice(2).join('、');
                tags.appendChild(more);
            }
        }

        row.append(status, main);
        if (tags) row.appendChild(tags);
        return row;
    }

    dom.btnSourcesRetry.addEventListener('click', refreshSources);

    /* =====================================================================
       保存筛选结果
       ===================================================================== */

    var saveLabelTimer = null;
    var toastTimer = null;

    function setSaveLabel(text) {
        dom.saveLabel.textContent = text;
    }

    function resetSaveLabelSoon(delay) {
        window.clearTimeout(saveLabelTimer);
        saveLabelTimer = window.setTimeout(function () {
            setSaveLabel(state.saving ? '正在保存…' : '保存筛选结果');
        }, delay || 1800);
    }

    function updateSaveButton() {
        var canSave = Boolean(state.uploadId) && state.selected.size > 0 && !state.saving;
        dom.btnSave.disabled = !canSave;
        dom.btnSave.setAttribute('aria-busy', state.saving ? 'true' : 'false');
    }

    function getDownloadFilename(response) {
        var header = response.headers.get('Content-Disposition') || '';
        var utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
        if (utf8Match) {
            try {
                return decodeURIComponent(utf8Match[1]);
            } catch (error) {
                /* 交给下面的普通 filename 兜底 */
            }
        }
        var plainMatch = /filename="?([^";]+)"?/i.exec(header);
        return plainMatch ? plainMatch[1] : '';
    }

    function triggerDownload(blob, filename) {
        var url = URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename || 'bookSources_filtered.json';
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 1500);
    }

    function showToast(message, tone) {
        dom.toastText.textContent = message;
        dom.toast.setAttribute('data-tone', tone || 'success');
        dom.toast.hidden = false;
        window.requestAnimationFrame(function () {
            dom.toast.classList.add('is-visible');
        });
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            dom.toast.classList.remove('is-visible');
            window.setTimeout(function () {
                dom.toast.hidden = true;
            }, 220);
        }, 2800);
    }

    async function saveSelectedSources() {
        if (state.saving || !state.uploadId || !state.selected.size) return;

        state.saving = true;
        setSaveLabel('正在保存…');
        updateSaveButton();

        try {
            var response = await fetch('/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    upload_id: state.uploadId,
                    groups: Array.from(state.selected)
                })
            });

            if (!response.ok) {
                var errorPayload = await response.json().catch(function () {
                    return {};
                });
                throw new Error(errorPayload.error || '保存失败（HTTP ' + response.status + '）');
            }

            var blob = await response.blob();
            var countHeader = Number(response.headers.get('X-Source-Count'));
            var filename = getDownloadFilename(response) || 'bookSources_filtered.json';

            triggerDownload(blob, filename);
            setSaveLabel('已下载');
            showToast(
                Number.isFinite(countHeader) && countHeader > 0
                    ? '已导出 ' + formatNumber(countHeader) + ' 条书源'
                    : '已开始下载筛选结果',
                'success'
            );
        } catch (error) {
            setSaveLabel('保存失败');
            showToast(error.message || '保存失败，请稍后重试。', 'error');
        } finally {
            state.saving = false;
            updateSaveButton();
            resetSaveLabelSoon(1800);
        }
    }

    dom.btnSave.addEventListener('click', saveSelectedSources);

    /* ---------- 启动 ---------- */
    initTheme();
    updateSaveButton();
})();
