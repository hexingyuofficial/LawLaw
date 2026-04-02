# 豆包 / 火山方舟：联网两种用法（可复制 JSON）

官方文档：[联网搜索 Web Search](https://www.volcengine.com/docs/82379/1756990)

LawLaw 内：**问答**模式下可勾选「联网搜索」走 **方案 ①**；或在同页「自行检索摘录」粘贴文字走 **方案 ②**（与方案 ① 互斥：有摘录时不传 `web_search` 工具）。

实际 `model` 一般为接入点 ID（如 `ep-xxxx`），请在控制台与齿轮里配置的 Chat 接入点一致。

---

## 方案 ①：官方原生联网（`web_search` 工具）

自动联网、延迟与计费以方舟为准。

```json
{
  "model": "ep-你的接入点ID",
  "messages": [
    {"role": "user", "content": "2026年最新AI音频模型对比"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "description": "在互联网上检索与问题相关的最新公开信息。",
        "parameters": { "type": "object", "properties": {} }
      }
    }
  ],
  "tool_choice": "auto",
  "temperature": 0.7,
  "max_tokens": 2048,
  "stream": true
}
```

`curl` 示例（替换 `$ARK_API_KEY` 与 `model`）：

```bash
curl https://ark.cn-beijing.volces.com/api/v3/chat/completions \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{
  "model": "ep-你的接入点ID",
  "messages": [{"role":"user","content":"2026年最新AI音频模型对比"}],
  "tools": [{"type":"function","function":{"name":"web_search","description":"联网搜索","parameters":{"type":"object","properties":{}}}}],
  "tool_choice": "auto",
  "temperature": 0.7,
  "max_tokens": 2048,
  "stream": true
}
EOF
```

---

## 方案 ②：先自行搜索，再把摘录喂给模型（最稳）

应用侧或脚本里先调用搜索引擎 / 打开网页复制要点，再拼进 `user.content`。

```json
{
  "model": "ep-你的接入点ID",
  "messages": [
    {
      "role": "system",
      "content": "你根据我给你的实时网络资料，精炼、准确回答问题，不要只回复嗯。"
    },
    {
      "role": "user",
      "content": "问题：最新AI混音模型推荐\n实时网络资料：【这里粘贴你自己搜出来的网页文本】"
    }
  ],
  "temperature": 0.6,
  "max_tokens": 3072,
  "stream": true
}
```

LawLaw 中在 **问答** 模式填写「自行检索摘录」输入框即等价于把 `实时网络资料：` 段落入上述结构（系统提示已按法律顾问场景微调）。
