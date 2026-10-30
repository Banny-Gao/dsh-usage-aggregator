# ADR 0002 · 功能模块契约

- **状态**：已采纳
- **日期**：2026-10-30

## 背景

不采用包边界（见 ADR 0001）之后，「一个功能」与「其它功能」之间的隔离要靠别的东西保证。三个源插件的代码风格差异极大：主题是带 `inject` 的 ESM，用量查询是共享作用域的拼接片段，插件更新是手写单文件。若只是把它们「搬进目录」，隔离性仍然是零。

## 决策

引入**显式的功能契约**：客户端与 Host 各有一套固定形状的导出，聚合层只认这个形状。

### 客户端功能契约（`src/client/features/<id>/index.js`）

```js
export const meta = { id, namespace, hubOrder }
export const dictionaries = { zh, en }
export function apply(ctx, t) { … }
export function HubView(props) { … }
```

### Host 功能契约（`src/host/features/<id>/index.js`）

```js
export const id = 'usage'
export const routePrefix = 'usage'
export function apply(ctx, featureConfig, shared) { … }
```

## 理由

- **契约本身就是文档**：`src/client/features/index.js` 的文件头写明了每个成员的意义与约束，新人加功能时照着抄即可。
- **装配层不用再改**：加功能 = 加一个目录 + 在两个 registry 文件里各加一行。装配层（`src/client/index.js` / `src/host/index.js`）是稳定的。
- **依赖方向单一**：功能 → 共享内核 → 运行时。功能之间**不互相 import**（只有 `src/*/features/index.js` 这个 registry 同时看见三者）。
- **`apply(ctx, t)` 把 translator 显式传进去**，避免每个功能自己去探命名空间、也避免命名空间注册与 translator 构造的顺序坑。

## 后果

- 功能必须遵守契约的形状，代价是多写几行 `export`。
- 契约演进时（例如将来要加 `onUnload` 钩子）需要同时改三个功能 —— 但那是有意的：契约变更必须显式发生，不允许悄悄漂移。
- `dictionaries` 必须含 `hubTab` 键 —— 契约检查脚本会断言这一点。

## 备选方案

- **按目录约定而非显式导出**：靠文件名约定识别功能。省掉 export，但装配层要去猜哪个文件是入口，遇到 `index.js` 之外的名字就失效。放弃。
- **每个功能一个 npm 包**：见 ADR 0001。
