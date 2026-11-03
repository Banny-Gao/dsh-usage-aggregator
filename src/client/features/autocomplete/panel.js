// src/client/features/autocomplete/panel.js
//
// 聚合设置页里的「AI 补全」页签。
//
// 只做一件事：读写 Host 那边存的设置。设置项自己管（不用配置表单服务）——
// 这个插件的其他页面也都是自己管的，用量查询存自己的 store、主题存
// localStorage，这里存 $DSH_HOME/dsh-usage-aggregator/autocomplete.json。
//
// 模型选择用**一个下拉**：Host 那边把 provider 与 model 摊平成
// "provider · model" 逐项列出。没用「用量查询」页那个级联选择器 —— 它连着
// 那个功能的接口与样式，搬过来等于把两个功能焊在一起（功能之间零 import）。

import { h, useEffect, useState } from '../../runtime.js';
import { api } from './api.js';
import { Styles } from './styles.js';

/**
 * 把 provider 与 model 摊平成下拉里的一项一项。
 *
 * @param {Array<object>} providers Host 给的 provider 清单。
 * @returns {Array<{value: string, label: string, group: string}>} 选项。
 */
export function modelOptions(providers) {
  const list = Array.isArray(providers) ? providers : [];
  const out = [];
  for (const provider of list) {
    if (provider === null || typeof provider !== 'object') continue;
    const providerId = typeof provider.id === 'string' ? provider.id : '';
    if (providerId === '') continue;
    const providerName = typeof provider.name === 'string' && provider.name !== '' ? provider.name : providerId;
    const models = Array.isArray(provider.models) ? provider.models : [];
    for (const model of models) {
      if (model === null || typeof model !== 'object') continue;
      const modelId = typeof model.id === 'string' ? model.id : '';
      if (modelId === '') continue;
      const modelName = typeof model.name === 'string' && model.name !== '' ? model.name : modelId;
      out.push({ value: providerId + '\u0000' + modelId, label: providerName + ' · ' + modelName, group: providerName });
    }
  }
  return out;
}

/**
 * 数字输入项。
 *
 * @param {{label: string, hint: string, value: number, min: number, max: number, onChange: Function}} props 属性。
 * @returns {object} React 元素。
 */
function NumberField(props) {
  return h('div', { className: 'dsh-ac-field' },
    h('div', { className: 'dsh-ac-field-main' },
      h('span', { className: 'dsh-ac-label' }, props.label),
      h('span', { className: 'dsh-ac-hint' }, props.hint)
    ),
    h('div', { className: 'dsh-ac-control' },
      h('input', {
        type: 'number',
        className: 'dsh-ac-number',
        value: props.value,
        min: props.min,
        max: props.max,
        step: 1,
        onChange: function (event) {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) props.onChange(next);
        },
      })
    )
  );
}

/**
 * 开关项。
 *
 * @param {{label: string, hint: string, checked: boolean, onChange: Function}} props 属性。
 * @returns {object} React 元素。
 */
function ToggleField(props) {
  return h('div', { className: 'dsh-ac-field' },
    h('div', { className: 'dsh-ac-field-main' },
      h('span', { className: 'dsh-ac-label' }, props.label),
      h('span', { className: 'dsh-ac-hint' }, props.hint)
    ),
    h('div', { className: 'dsh-ac-control' },
      h('input', {
        type: 'checkbox',
        className: 'dsh-ac-check',
        checked: props.checked === true,
        onChange: function (event) { props.onChange(event.target.checked === true); },
      })
    )
  );
}

/**
 * 「AI 补全」页签。
 *
 * @param {{t: Function, initialSettings?: object, initialModels?: object}} props 属性。
 *   initialSettings / initialModels 只给离线渲染自检用
 *   （scripts/ui-check-autocomplete.mjs）：真页面上永远是 undefined，数据由下面的
 *   useEffect 去 Host 拉。
 * @returns {object} React 元素。
 */
export function AutocompletePanel(props) {
  const t = props.t;
  const [settings, setSettings] = useState(props.initialSettings ?? null);
  const [models, setModels] = useState(props.initialModels ?? null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(function () {
    let alive = true;
    api.settings().then(function (result) {
      if (!alive) return;
      setSettings(result !== null && typeof result === 'object' && result.settings !== null ? result.settings : null);
    }).catch(function (failure) {
      if (!alive) return;
      setError(t('loadFailed', { error: String(failure.message || failure) }));
    });
    api.models().then(function (result) {
      if (!alive) return;
      setModels(result !== null && typeof result === 'object' ? result : null);
    }).catch(function () {
      // 模型清单拿不到就只留「用默认」—— 不影响其它设置项。
    });
    return function () { alive = false; };
  }, [t]);

  if (settings === null) {
    return h('div', { className: 'dsh-ac-page' },
      h(Styles, null),
      error !== '' ? h('p', { className: 'dsh-ac-msg is-error' }, error) : h('p', { className: 'dsh-ac-msg' }, '…')
    );
  }

  /**
   * 改一项设置。
   *
   * @param {string} key 字段名。
   * @param {unknown} value 新值。
   */
  const change = function (key, value) {
    setSettings(function (current) {
      return current === null ? current : { ...current, [key]: value };
    });
    setMessage('');
    setError('');
  };

  /**
   * 保存。
   */
  const save = function () {
    setBusy(true);
    setMessage('');
    setError('');
    api.saveSettings({
      enabled: settings.enabled,
      maxSuggestions: settings.maxSuggestions,
      minChars: settings.minChars,
      debounceMs: settings.debounceMs,
      contextMessages: settings.contextMessages,
      maxInputChars: settings.maxInputChars,
      allowMultiline: settings.allowMultiline,
      inlineHint: settings.inlineHint,
      placeholderHint: settings.placeholderHint,
      provider: settings.provider,
      model: settings.model,
    }).then(function (result) {
      setBusy(false);
      if (result !== null && typeof result === 'object' && result.settings !== null) setSettings(result.settings);
      setMessage(t('saved'));
    }).catch(function (failure) {
      setBusy(false);
      setError(t('saveFailed', { error: String(failure.message || failure) }));
    });
  };

  const options = modelOptions(models?.providers);
  const modelValue = settings.provider === '' ? '' : settings.provider + '\u0000' + settings.model;
  const groups = [];
  for (const option of options) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.group === option.group) last.items.push(option);
    else groups.push({ group: option.group, items: [option] });
  }

  return h('div', { className: 'dsh-ac-page' },
    h(Styles, null),
    h('p', { className: 'dsh-ac-intro' }, t('intro')),

    h('div', { className: 'dsh-ac-card' },
      h('h3', { className: 'dsh-ac-card-title' }, t('sectionSuggest')),
      ToggleField({
        label: t('enabled'),
        hint: t('enabledHint'),
        checked: settings.enabled === true,
        onChange: function (value) { change('enabled', value); },
      }),
      NumberField({
        label: t('maxSuggestions'),
        hint: t('maxSuggestionsHint'),
        value: settings.maxSuggestions,
        min: 1,
        max: 5,
        onChange: function (value) { change('maxSuggestions', value); },
      })
    ),

    h('div', { className: 'dsh-ac-card' },
      h('h3', { className: 'dsh-ac-card-title' }, t('sectionTrigger')),
      NumberField({
        label: t('minChars'),
        hint: t('minCharsHint'),
        value: settings.minChars,
        min: 0,
        max: 200,
        onChange: function (value) { change('minChars', value); },
      }),
      NumberField({
        label: t('debounce'),
        hint: t('debounceHint'),
        value: settings.debounceMs,
        min: 0,
        max: 5000,
        onChange: function (value) { change('debounceMs', value); },
      }),
      NumberField({
        label: t('contextMessages'),
        hint: t('contextMessagesHint'),
        value: settings.contextMessages,
        min: 0,
        max: 10,
        onChange: function (value) { change('contextMessages', value); },
      }),
      NumberField({
        label: t('maxInputChars'),
        hint: t('maxInputCharsHint'),
        value: settings.maxInputChars,
        min: 100,
        max: 20000,
        onChange: function (value) { change('maxInputChars', value); },
      })
    ),

    h('div', { className: 'dsh-ac-card' },
      h('h3', { className: 'dsh-ac-card-title' }, t('sectionDisplay')),
      ToggleField({
        label: t('allowMultiline'),
        hint: t('allowMultilineHint'),
        checked: settings.allowMultiline === true,
        onChange: function (value) { change('allowMultiline', value); },
      }),
      ToggleField({
        label: t('inlineHint'),
        hint: t('inlineHintHint'),
        checked: settings.inlineHint === true,
        onChange: function (value) { change('inlineHint', value); },
      }),
      ToggleField({
        label: t('placeholderHint'),
        hint: t('placeholderHintHint'),
        checked: settings.placeholderHint === true,
        onChange: function (value) { change('placeholderHint', value); },
      })
    ),

    h('div', { className: 'dsh-ac-card' },
      h('h3', { className: 'dsh-ac-card-title' }, t('analysisModel')),
      h('div', { className: 'dsh-ac-field' },
        h('div', { className: 'dsh-ac-field-main' },
          h('span', { className: 'dsh-ac-label' }, t('analysisModel')),
          h('span', { className: 'dsh-ac-hint' }, t('analysisModelHint'))
        ),
        h('div', { className: 'dsh-ac-control' },
          h('select', {
            className: 'dsh-ac-number',
            style: { width: '260px' },
            value: modelValue,
            onChange: function (event) {
              const raw = String(event.target.value);
              if (raw === '') {
                change('provider', '');
                change('model', '');
                return;
              }
              const split = raw.indexOf('\u0000');
              change('provider', raw.slice(0, split));
              change('model', raw.slice(split + 1));
            },
          },
          h('option', { value: '' }, t('analysisDefault')),
          groups.map(function (group) {
            return h('optgroup', { key: group.group, label: group.group },
              group.items.map(function (option) {
                return h('option', { key: option.value, value: option.value }, option.label);
              })
            );
          }))
        )
      )
    ),

    h('div', { className: 'dsh-ac-field' },
      h('div', { className: 'dsh-ac-control' },
        h('button', {
          type: 'button',
          className: 'dsh-ac-btn is-primary',
          disabled: busy === true,
          onClick: save,
        }, t('save'))
      ),
      message !== '' ? h('span', { className: 'dsh-ac-msg is-ok' }, message) : null,
      error !== '' ? h('span', { className: 'dsh-ac-msg is-error' }, error) : null
    ),

    h('p', { className: 'dsh-ac-foot' }, t('foot'))
  );
}
