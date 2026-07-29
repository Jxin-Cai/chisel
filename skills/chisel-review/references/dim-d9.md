# 维度 D9：安全审查

## 审查目标

识别本次变更引入的安全漏洞——注入攻击、认证绕过、敏感数据泄露。

遗留系统安全债务重，新增代码必须不引入新的攻击面，同时不恶化已有的安全态势。

## 检查清单

### 1. 注入攻击

- SQL 查询是否使用参数化/预编译语句？是否存在字符串拼接构建查询？
- NoSQL 查询（MongoDB 等）是否对用户输入做了类型校验？
- 命令执行（exec/spawn/execSync）是否拼接了用户可控输入？
- LDAP/XPath/模板注入是否可能？

### 2. 跨站脚本（XSS）

- 用户输入是否经过转义后才渲染到 HTML/JSX？
- 是否使用了 `innerHTML`、`dangerouslySetInnerHTML`、`v-html` 等危险 API？
- URL 参数是否直接用于页面渲染而未过滤？
- Rich text/Markdown 渲染是否配置了 sanitizer？

### 3. 认证与授权

- 新接口是否配置了认证中间件/装饰器？
- 是否存在权限降级（原本需要 admin 权限的操作，新代码绕过检查）？
- Session/Token 验证是否在新路径上被跳过？
- 是否存在水平越权（用户 A 可操作用户 B 的资源）？

### 4. 敏感数据保护

- 密钥/Token/密码是否硬编码在源码中？
- 日志/错误信息中是否暴露了敏感字段（密码、身份证、银行卡）？
- API 响应是否返回了不必要的敏感字段？
- 数据库中敏感字段是否加密存储？

### 5. 路径遍历与文件操作

- 文件路径是否由用户输入控制（`../` 攻击）？
- 文件上传是否校验了类型、大小、文件名？
- 临时文件是否存在竞态条件（symlink attack）？

### 6. 服务端请求伪造（SSRF）

- 是否存在用户可控的 URL 被服务端直接 fetch？
- 内部服务的 URL 是否暴露给了外部调用者？
- 重定向是否验证了目标域名？

### 7. 不安全的反序列化

- 是否使用了 `eval()`、`Function()`、`unserialize()` 处理外部数据？
- JSON.parse 后的对象是否直接作为查询条件使用（prototype pollution）？
- 是否对反序列化后的类型进行了验证？

### 8. 密码学误用

- 是否使用了已知不安全的算法（MD5/SHA1 用于安全场景）？
- 随机数生成是否使用了加密安全的 PRNG？
- TLS/加密配置是否安全？

## CR 产物格式

### Frontmatter

```yaml
---
dimension: d9
result: pass | fail
affected_tasks: [task-001]
rework_count: 0
---
```

### 正文模板

```markdown
# D9 CR: 安全审查

## 结论

PASS | FAIL | N/A

<简要说明理由>

## 检查结果

| 检查项 | Task | 结果 | 说明 |
|--------|------|------|------|
| 注入攻击 | task-001 | PASS/FAIL/N/A | <说明> |
| XSS | task-001 | PASS/FAIL/N/A | <说明> |
| 认证与授权 | task-001 | PASS/FAIL/N/A | <说明> |
| 敏感数据保护 | task-001 | PASS/FAIL/N/A | <说明> |
| 路径遍历 | task-001 | PASS/FAIL/N/A | <说明> |
| SSRF | task-001 | PASS/FAIL/N/A | <说明> |
| 不安全的反序列化 | task-001 | PASS/FAIL/N/A | <说明> |
| 密码学误用 | task-001 | PASS/FAIL/N/A | <说明> |

## 问题详情

（FAIL 项逐条展开）

### 问题 1

- 位置：<文件:行号>
- 漏洞类型：<8 类之一>
- 攻击向量：<具体利用路径>
- 风险等级：critical/high/medium/low
- 修复建议：<代码级修复方向>

> 📎 Read `dim-shared-footer.md` 获取 CR 产物格式模板（Scope/Wiki、Rework Items / Observations / Rework Verification 表格格式）
```

## 不要标记

- 框架自带的安全防护（如 ORM 参数化查询、React 默认转义）已覆盖的场景
- 仅在内部网络/管理后台使用且有网络层隔离的接口
- 已有 WAF/安全中间件处理的通用防护（除非代码明确绕过）
- 测试代码/mock 中的硬编码凭证（非生产环境）
- 已被 `.gitignore` 排除的配置文件中的凭证模板
5. **置信度**：0-100 分
