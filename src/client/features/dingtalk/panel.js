// src/client/features/dingtalk/panel.js
//
// 聚合设置页里的「钉钉」页签。
//
// 只做三件事：开关这个功能、看状态（dws 装没装、未读多少、最近一次拉取）、
// 手动拉一次。设置项自己管（存在 $DSH_HOME/dsh-usage-aggregator/dingtalk.json）。

import { h, useEffect, useState } from '../../runtime.js';
import { api } from './api.js';
import { Styles } from './styles.js';

/**
 * 把毫秒时间戳变成一句能读的时间。
 *
 * @param {number} ms 毫秒时间戳（0 表示没有）。
 * @returns {string} 文本。
 */
function stamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  );
}

/**
 * 开关项。
 *
 * @param {{label: string, hint: string, checked: boolean, onChange: Function}} props 属性。
 * @returns {object} React 元素。
 */
function ToggleField(props) {
  return h('div', { className: 'dsh-dt-field' },
    h('div', { className: 'dsh-dt-field-main' },
      h('span', { className: 'dsh-dt-label' }, props.label),
      h('span', { className: 'dsh-dt-hint' }, props.hint)
    ),
    h('div', { className: 'dsh-dt-control' },
      h('input', {
        type: 'checkbox',
        className: 'dsh-dt-check',
        checked: props.checked === true,
        onChange: (event) => props.onChange(event.target.checked === true),
      })
    )
  );
}

/**
 * 数字输入项。
 *
 * @param {{label: string, hint: string, value: number, min: number, max: number, onChange: Function}} props 属性。
 * @returns {object} React 元素。
 */
function NumberField(props) {
  return h('div', { className: 'dsh-dt-field' },
    h('div', { className: 'dsh-dt-field-main' },
      h('span', { className: 'dsh-dt-label' }, props.label),
      h('span', { className: 'dsh-dt-hint' }, props.hint)
    ),
    h('div', { className: 'dsh-dt-control' },
      h('input', {
        type: 'number',
        className: 'dsh-dt-number',
        value: props.value,
        min: props.min,
        max: props.max,
        step: 10,
        onChange: (event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) props.onChange(next);
        },
      })
    )
  );
}

/**
 * 「钉钉」页签。
 *
 * @param {{t: Function, initialStatus?: object}} props 属性。
 *   initialStatus 只给离线渲染自检用；真页面上数据由下面的 useEffect 去 Host 拉。
 * @returns {object} React 元素。
 */
export function DingtalkPanel(props) {
  const t = props.t;
  const [status, setStatus] = useState(props.initialStatus ?? null);
  const [settings, setSettings] = useState(props.initialStatus?.settings ?? null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);

  /**
   * 重新读一次 Host 的状态。
   */
  const refresh = () => {
    api.status().then((result) => {
      setStatus(result !== null && typeof result === 'object' ? result : null);
      if (result !== null && typeof result === 'object' && result.settings !== null) setSettings(result.settings);
    }).catch((failure) => {
      setError(t('loadFailed', { error: String(failure.message || failure) }));
    });
  };

  useEffect(function () {
    let alive = true;
    api.status().then((result) => {
      if (!alive) return;
      setStatus(result !== null && typeof result === 'object' ? result : null);
      if (result !== null && typeof result === 'object' && result.settings !== null) setSettings(result.settings);
    }).catch((failure) => {
      if (!alive) return;
      setError(t('loadFailed', { error: String(failure.message || failure) }));
    });
    return function () { alive = false; };
  }, [t]);

  if (settings === null) {
    return h('div', { className: 'dsh-dt-page' },
      h(Styles, null),
      error !== '' ? h('p', { className: 'dsh-dt-msg is-error' }, error) : h('p', { className: 'dsh-dt-msg' }, '…')
    );
  }

  /**
   * 改一项设置。
   *
   * @param {string} key 字段名。
   * @param {unknown} value 新值。
   */
  const change = (key, value) => {
    setSettings((current) => (current === null ? current : { ...current, [key]: value }));
    setMessage('');
    setError('');
  };

  /**
   * 保存。开关的落盘与生效都在 Host 侧（存文件 + 注册/注销）。
   */
  const save = () => {
    setBusy(true);
    setMessage('');
    setError('');
    api.saveSettings({
      enabled: settings.enabled === true,
      pollIntervalSeconds: settings.pollIntervalSeconds,
    }).then((result) => {
      setBusy(false);
      if (result !== null && typeof result === 'object' && result.settings !== null) setSettings(result.settings);
      setMessage(t('saved'));
      refresh();
    }).catch((failure) => {
      setBusy(false);
      setError(t('saveFailed', { error: String(failure.message || failure) }));
    });
  };

  /**
   * 手动拉一次。
   */
  const poll = () => {
    setPolling(true);
    setMessage('');
    setError('');
    api.poll().then((result) => {
      setPolling(false);
      if (result !== null && typeof result === 'object' && result.ok === false) {
        setError(t('pollFailed', { error: String(result.error || '') }));
        return;
      }
      setMessage(t('pollDone', {
        count: String(result?.count ?? 0),
        relevant: String(result?.relevant ?? 0),
      }));
      refresh();
    }).catch((failure) => {
      setPolling(false);
      setError(t('pollFailed', { error: String(failure.message || failure) }));
    });
  };

  const availability = status?.availability ?? { installed: false, version: '' };
  const at = status?.lastPollAt ?? 0;

  return h('div', { className: 'dsh-dt-page' },
    h(Styles, null),
    h('p', { className: 'dsh-dt-intro' }, t('intro')),

    h('div', { className: 'dsh-dt-card-box' },
      h('h3', { className: 'dsh-dt-card-title' }, t('sectionSwitch')),
      ToggleField({
        label: t('enabled'),
        hint: t('enabledHint'),
        checked: settings.enabled === true,
        onChange: (value) => change('enabled', value),
      })
    ),

    h('div', { className: 'dsh-dt-card-box' },
      h('h3', { className: 'dsh-dt-card-title' }, t('sectionStatus')),
      h('p', { className: 'dsh-dt-msg' },
        availability.installed === true ? t('dwsReady') : t('dwsMissing'),
        availability.installed === true && availability.version !== '' ? '（' + t('dwsVersion', { version: availability.version }) + '）' : ''
      ),
      h('p', { className: 'dsh-dt-msg' }, t('unread', { count: String(status?.unread ?? 0) })),
      h('p', { className: 'dsh-dt-msg' },
        at === 0
          ? t('neverPolled')
          : t('lastPoll', { at: stamp(at), count: String(status?.lastPollCount ?? 0) })
      ),
      Number.isFinite(status?.lastBaselined) && status.lastBaselined > 0
        ? h('p', { className: 'dsh-dt-msg is-warn' }, t('baseline', { count: String(status.lastBaselined) }))
        : null,
      status?.lastError ? h('p', { className: 'dsh-dt-msg is-error' }, String(status.lastError)) : null,
      h('div', { className: 'dsh-dt-field' },
        h('div', { className: 'dsh-dt-control' },
          h('button', {
            type: 'button',
            className: 'dsh-dt-btn',
            disabled: polling === true || settings.enabled !== true,
            onClick: poll,
          }, polling === true ? t('polling') : t('pollNow'))
        )
      )
    ),

    h('div', { className: 'dsh-dt-card-box' },
      h('h3', { className: 'dsh-dt-card-title' }, t('sectionInterval')),
      NumberField({
        label: t('interval'),
        hint: t('intervalHint'),
        value: settings.pollIntervalSeconds,
        min: 60,
        max: 3600,
        onChange: (value) => change('pollIntervalSeconds', value),
      })
    ),

    h('div', { className: 'dsh-dt-card-box' },
      h('h3', { className: 'dsh-dt-card-title' }, t('sectionRules')),
      h('p', { className: 'dsh-dt-intro' }, t('rules'))
    ),

    h('div', { className: 'dsh-dt-field' },
      h('div', { className: 'dsh-dt-control' },
        h('button', {
          type: 'button',
          className: 'dsh-dt-btn is-primary',
          disabled: busy === true,
          onClick: save,
        }, t('save'))
      ),
      message !== '' ? h('span', { className: 'dsh-dt-msg is-ok' }, message) : null,
      error !== '' ? h('span', { className: 'dsh-dt-msg is-error' }, error) : null
    ),

    h('p', { className: 'dsh-dt-foot-note' }, t('foot'))
  );
}
