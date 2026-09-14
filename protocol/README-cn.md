# protocol

跨语言 SDK 真相源。各语言 SDK 实现这套协议、跑通这套测试向量、用 `data/` 生成枚举。

[English](./README.md) | 简体中文

## 内容

| 文件 | 说明 |
|---|---|
| [merchant-api.md](./merchant-api.md) | endpoint 总览 + SDK 设计规则 |
| [signature.md](./signature.md) | Ed25519 / RFC 9421 请求签名 |
| [body-encryption.md](./body-encryption.md) | X25519 sealed box body envelope |
| [webhook.md](./webhook.md) | webhook payload + 平台签名验证 |
| [errors.md](./errors.md) | 响应 envelope、错误码、成功判定 |
| `data/` | 机器可读枚举与规则:methods、currencies、countries、statuses、endpoints、method-rules、request-rules |
| `testdata/` | 各语言 SDK 必须跑通的固定一致性向量 |

## 测试向量

| 目录 | 内容 |
|---|---|
| `testdata/signature/` | Ed25519 签名向量:请求、签名基串、签名 |
| `testdata/bodycrypt/` | sealed box 向量:密钥对、明文、envelope |
| `testdata/empty-object-post/` | `{}` 明文、envelope、摘要和 POST 签名向量 |
| `testdata/webhook/` | 签名 webhook 向量 + 拒绝用例 |
| `testdata/responses/` | envelope 解码向量(成功、APIError、非 JSON) |
| `testdata/validation/` | 本地校验向量:一条合法 base 请求 + 各语言必须一致的放行/拒绝用例 |

签名和 webhook 向量是确定性的(固定密钥、`created`、`nonce`)。sealed box 密文非确定性,
所以向量给出密钥对、明文和一个样例 envelope,一致性判定为 open(envelope) == 明文。
