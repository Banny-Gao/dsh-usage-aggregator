// src/client/features/usage/provider.js
//
// 供应商详情（对应源插件的 06-provider.js）。
//
// 渲染是**哑的**：所有取数、格式化、状态判定都在 Host 侧完成（host/features/usage），
// 这里只画 —— 所以接入新接口时这个文件一行都不用改。

import { React, h, useState, useEffect } from '../../runtime.js';
import { api } from './api.js';
import { clockTime, dueText, durationText, relativeTime, statusTone } from './format.js';
import { Badge, Banner, Button, ImageDrop, UsageView } from './atoms.js';
import { FieldOrderEditor } from './field-order.js';

/**
 * 状态 → 字典 key。
 *
 * @param {string} status 状态。
 * @returns {string} 字典 key。
 */
export function statusKey(status) {
  if (status === 'ok') return 'stateOk';
  if (status === 'expired') return 'stateExpired';
  if (status === 'error') return 'stateError';
  if (status === 'snapshot') return 'stateSnapshot';
  return 'stateEmpty';
}

/**
 * 供应商详情卡片。
 *
 * @param {object} props 属性。
 * @returns {object} React 元素。
 */
export function ProviderDetail(props) {
  var t = props.t;
  var provider = props.provider;
  var busy = props.busy;
  var [rawText, setRawText] = useState(null);
  var [rawError, setRawError] = useState('');
  var [confirmRemove, setConfirmRemove] = useState(false);
  var [copied, setCopied] = useState(false);
  var [hintOpen, setHintOpen] = useState(false);
  var [hintImage, setHintImage] = useState(null);
  var [hintError, setHintError] = useState('');

  useEffect(function () {
    setRawText(null);
    setRawError('');
    setConfirmRemove(false);
    setCopied(false);
    setHintOpen(false);
    setHintImage(null);
    setHintError('');
  }, [provider.id]);

  var credential = provider.credential || {};
  var status = provider.status;
  var view = provider.view;
  var canQuery = provider.queryable === true;
  // 自动续期：Host 端认得这个站点的登录方式时才有。点一下弹窗、点一次「同意」。
  var renewal = provider.renewal || {};
  var canRenew = renewal.supported === true && provider.source === 'curl';
  // 快到期了就提前亮出来，别等 401 之后再想起这件事。
  var expSoon = typeof credential.exp === 'number'
    && credential.exp * 1000 > Date.now()
    && credential.exp * 1000 - Date.now() < 3 * 3600 * 1000;
  var showRenew = canRenew && (status === 'expired' || expSoon === true);

  var credentialText = (function () {
    if (credential.found !== true) return t('credentialNone');
    if (typeof credential.exp !== 'number') return t('credentialOpaque');
    var ms = credential.exp * 1000;
    if (ms <= Date.now()) return t('credentialExpired', { time: clockTime(ms) });
    return t('credentialExpires', { time: clockTime(ms), left: durationText(ms - Date.now()) });
  })();

  var loadRaw = function () {
    api.raw(provider.id).then(function (result) {
      setRawText(typeof result.text === 'string' ? result.text : JSON.stringify(result.data, null, 2));
    }).catch(function (error) {
      setRawError(String(error.message || error));
    });
  };

  var copyTemplate = function () {
    var text = JSON.stringify(provider.template, null, 2);
    try {
      navigator.clipboard.writeText(text).then(function () { setCopied(true); });
    } catch (err) {
      setCopied(false);
    }
  };

  return h('section', { className: 'duq-card' },
    h('div', { className: 'duq-card-head' },
      h('div', { className: 'duq-card-titles' },
        h('div', { className: 'duq-card-titlerow' },
          h('h3', { className: 'duq-card-title' }, provider.label),
          h(Badge, { text: t(statusKey(status)), tone: statusTone(status) }),
          provider.source === 'image' ? h(Badge, { text: t('sourceImage'), tone: 'info' }) : null,
          provider.templateSource === 'auto' ? h(Badge, { text: t('sourceModel'), tone: 'ok' }) : null,
          provider.templateSource === 'fallback' ? h(Badge, { text: t('sourceFallback'), tone: 'warn' }) : null
        ),
        h('div', { className: 'duq-meta' },
          h('span', { className: 'duq-meta-item' }, provider.endpoint === null ? t('sourceImage') : provider.endpoint),
          h('span', { className: 'duq-meta-item' }, t('lastUpdated') + '：' + (provider.last === null ? t('neverQueried') : relativeTime(provider.last.at, t) + '（' + clockTime(provider.last.at) + '）')),
          provider.last !== null && provider.last.httpStatus !== null ? h('span', { className: 'duq-meta-item' }, 'HTTP ' + provider.last.httpStatus) : null,
          provider.last !== null && provider.last.ms !== null ? h('span', { className: 'duq-meta-item' }, t('took') + ' ' + provider.last.ms + 'ms') : null,
          provider.last !== null && (provider.last.trigger === 'auto' || provider.last.trigger === 'import')
            ? h('span', { className: 'duq-meta-item' }, t('autoTag'))
            : null,
          dueText(provider.nextDueIn) === null ? null : h('span', { className: 'duq-meta-item' }, t('autoNext') + ' ' + dueText(provider.nextDueIn)),
          h('span', { className: 'duq-meta-item' }, t('credential') + '：' + credentialText)
        )
      ),
      h('div', { className: 'duq-card-actions' },
        canQuery ? h(Button, { onClick: function () { props.onRefresh(provider.id); }, disabled: busy }, t('refresh')) : null,
        // 续期是分钟级的阻塞操作（等人点「同意」），所以按钮文案换成进行中并全程置灰。
        canRenew ? h(Button, {
          variant: status === 'expired' ? 'primary' : 'quiet',
          disabled: busy,
          onClick: function () { props.onRenew(provider.id); }
        }, busy ? t('renewRunning') : t('renew')) : null,
        canQuery && provider.template !== null ? h(Button, { quiet: true, onClick: function () { props.onReanalyze(provider.id); }, disabled: busy }, t('reanalyze')) : null,
        canQuery && provider.template !== null ? h(Button, {
          quiet: true,
          disabled: busy,
          onClick: function () { setHintOpen(!hintOpen); }
        }, t('hintToggle')) : null,
        confirmRemove
          ? h(React.Fragment, null,
            h(Button, { variant: 'danger', onClick: function () { props.onRemove(provider.id); }, disabled: busy }, t('removeConfirm')),
            h(Button, { quiet: true, onClick: function () { setConfirmRemove(false); } }, t('removeCancel')))
          : h(Button, { quiet: true, onClick: function () { setConfirmRemove(true); } }, t('remove'))
      )
    ),

    hintOpen ? h('div', { className: 'duq-hintpanel' },
      h('div', { className: 'duq-hintpanel-title' }, t('hintTitle')),
      h('p', { className: 'duq-sub' }, t('hintHint')),
      h(ImageDrop, {
        t: t,
        image: hintImage,
        hint: t('dropHint'),
        pickLabel: t('pickImage'),
        readyText: t('hintReady'),
        clearLabel: t('hintClear'),
        onImage: function (next) { setHintImage(next); setHintError(''); },
        onError: setHintError,
        onClear: function () { setHintImage(null); }
      }),
      hintError !== '' ? h('div', { className: 'duq-error' }, hintError) : null,
      h('div', { className: 'duq-import-actions' },
        h(Button, {
          variant: 'primary',
          disabled: busy || hintImage === null,
          onClick: function () {
            props.onReanalyze(provider.id, hintImage);
            setHintImage(null);
            setHintOpen(false);
          }
        }, t('hintRun')),
        h(Button, {
          quiet: true,
          disabled: busy,
          onClick: function () { setHintOpen(false); }
        }, t('cancel'))
      )
    ) : null,

    status === 'expired' ? h(Banner, {
      tone: 'error',
      title: t('expiredTitle'),
      actions: h(React.Fragment, null,
        canRenew ? h(Button, { variant: 'primary', disabled: busy, onClick: function () { props.onRenew(provider.id); } }, t('renew')) : null,
        canQuery ? h(Button, { quiet: canRenew, onClick: function () { props.onUpdate(provider); } }, t('updateCredential')) : null)
    }, canRenew ? t('renewNeedsLogin') : t('expiredBody')) : null,

    status === 'error' && provider.last !== null && provider.last.message ? h(Banner, { tone: 'error', title: t('stateError') }, provider.last.message) : null,

    provider.source === 'image' ? h(Banner, { tone: 'info' }, provider.notes && provider.notes.length > 0 ? provider.notes[0] : t('stateSnapshot')) : null,

    h(UsageView, { view: view, t: t, placeholder: t('viewEmpty') }),

    Array.isArray(provider.notes) && provider.notes.length > 0
      ? h('ul', { className: 'duq-notes' }, provider.notes.map(function (note, index) { return h('li', { key: index }, note); }))
      : null,

    h('div', { className: 'duq-folders' },
      h('details', { className: 'duq-details', onToggle: function (event) { if (event.target.open === true && rawText === null && rawError === '') loadRaw(); } },
        h('summary', null, t('raw')),
        rawError !== '' ? h('div', { className: 'duq-error' }, rawError) : null,
        rawText === null ? h('div', { className: 'duq-placeholder' }, t('rawEmpty')) : h('pre', { className: 'duq-pre' }, rawText)
      ),
      provider.template !== null ? h('details', { className: 'duq-details' },
        h('summary', null, t('template')),
        h('div', { className: 'duq-template-actions' }, h(Button, { quiet: true, onClick: copyTemplate }, copied ? t('copied') : t('copy'))),
        h('pre', { className: 'duq-pre' }, JSON.stringify(provider.template, null, 2))
      ) : null,
      provider.source === 'curl' && provider.template !== null
        ? h(FieldOrderEditor, { t: t, provider: provider, onChanged: props.onReload })
        : null,
      provider.headerNames !== undefined && provider.headerNames.length > 0 ? h('details', { className: 'duq-details' },
        h('summary', null, t('requestHeaders')),
        h('div', { className: 'duq-chips' }, provider.headerNames.map(function (name) { return h('span', { className: 'duq-chip is-static', key: name }, name); }))
      ) : null
    )
  );
}
