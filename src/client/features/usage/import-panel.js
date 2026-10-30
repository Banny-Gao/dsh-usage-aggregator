// src/client/features/usage/import-panel.js
//
// 接入面板（对应源插件的 08-import.js）。
//
// ⚠️ 这里的 payload 形状与 Host 侧的 /usage/import 一一对应：label / replaceId /
// text / image。改字段名会直接让接入失败。

import { h, useState } from '../../runtime.js';
import { api } from './api.js';
import { Banner, Button, ImageDrop, readImageFile } from './atoms.js';

/**
 * 接入面板：贴一次 cURL（或一张截图）就接入一个接口。
 *
 * @param {{t: Function, image?: object, preset?: object|null, onCancel?: Function, onImported: Function}} props 属性。
 * @returns {object} React 元素。
 */
export function ImportPanel(props) {
  var t = props.t;
  var preset = props.preset || null;
  var [text, setText] = useState('');
  var [label, setLabel] = useState(preset === null ? '' : preset.label);
  var [image, setImage] = useState(null);
  var [busy, setBusy] = useState(false);
  var [error, setError] = useState('');
  var [phase, setPhase] = useState('');

  var submit = function () {
    if (busy) return;
    if (image === null && text.trim() === '') {
      setError(t('emptyBody'));
      return;
    }
    setBusy(true);
    setError('');
    setPhase(image !== null && text.trim() === '' ? t('importingImage') : t('importing'));
    var payload = { label: label.trim() === '' ? undefined : label.trim() };
    if (preset !== null) payload.replaceId = preset.id;
    if (text.trim() !== '') payload.text = text;
    if (image !== null) payload.image = { data: image.data, mediaType: image.mediaType };
    api.importRequest(payload).then(function (result) {
      setBusy(false);
      setPhase('');
      setText('');
      setImage(null);
      props.onImported(result.provider);
    }).catch(function (failure) {
      setBusy(false);
      setPhase('');
      setError(String(failure.message || failure));
    });
  };

  var imageDisabled = props.image !== undefined && props.image.enabled === false;

  return h('section', { className: 'duq-card duq-import' },
    h('h3', { className: 'duq-card-title' }, t('importTitle')),
    preset === null ? h('p', { className: 'duq-sub' }, t('importHint')) : h(Banner, { tone: 'warn' }, t('importUpdating', { name: preset.label })),
    imageDisabled ? h(Banner, { tone: 'info' }, t('imageDisabled', { reason: props.image.reason || '' })) : null,
    h('label', { className: 'duq-field' },
      h('span', { className: 'duq-field-label' }, t('nameLabel')),
      h('input', {
        className: 'duq-input', type: 'text', value: label, maxLength: 40,
        placeholder: t('namePlaceholder'),
        onChange: function (event) { setLabel(event.target.value); }
      })
    ),
    h('label', { className: 'duq-field' },
      h('span', { className: 'duq-field-label' }, t('pasteLabel')),
      h('textarea', {
        className: 'duq-textarea', rows: 6, value: text, spellCheck: false,
        placeholder: t('pastePlaceholder'),
        onChange: function (event) { setText(event.target.value); },
        onPaste: function (event) {
          var items = event.clipboardData === null || event.clipboardData === undefined ? [] : event.clipboardData.items;
          for (var i = 0; i < items.length; i += 1) {
            if (items[i].type !== undefined && items[i].type.indexOf('image/') === 0) {
              readImageFile(items[i].getAsFile(), t, function (next) { setImage(next); setError(''); }, setError);
            }
          }
        }
      })
    ),
    imageDisabled ? null : h(ImageDrop, {
      t: t,
      image: image,
      hint: t('dropHint'),
      pickLabel: t('pickImage'),
      readyText: t('imageReady'),
      clearLabel: t('imageClear'),
      onImage: function (next) { setImage(next); setError(''); },
      onError: setError,
      onClear: function () { setImage(null); }
    }),
    error !== '' ? h(Banner, { tone: 'error' }, error) : null,
    busy && phase !== '' ? h(Banner, { tone: 'info' }, phase) : null,
    h('div', { className: 'duq-import-actions' },
      h(Button, { variant: 'primary', onClick: submit, disabled: busy }, image !== null && text.trim() !== '' ? t('submitWithHint') : t('submit')),
      preset === null ? null : h(Button, { quiet: true, onClick: props.onCancel }, t('cancel'))
    )
  );
}

/**
 * 分析模型级联选择器（cascader）：一个按钮，点开后在浮层里先选 provider、再选 model。
 *
 * 为什么不用两个原生 <select> 并排：那会让页头横向占掉两三百像素，把标题挤到换行
 * （之前就真的挤成了竖排「用量查询」）。一个按钮 + 一个浮层，宽度自适应、换行友好，
 * 而且天然有「先 provider 后 model」的级联语义。
 */
