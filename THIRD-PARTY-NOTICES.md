# 第三方声明 / Third-Party Notices

本文件列出 NovelWriter Agent 中**移植的第三方代码**及其许可。
（依据 ADR-0009 决策 4：仓库为 public，「是否分发」不应成为许可合规的
唯一依据 —— 补一份声明的成本近乎为零，漏掉的成本是侵权。）

---

## oh-story-claudecode

- **来源**：`skills/story-deslop/scripts/check-ai-patterns.js`
- **移植到**：`packages/writing/src/naturalness/ported-detectors.ts`
- **移植内容**：7 类检测器的正则与阈值、以及其假阳性豁免逻辑
  （`not_is_comparison` / `reverse_not_is` / `voice_contrast` /
  `negation_parade` / `trailer_ending` / `trailer_summary` / `em_dash`）
- **未移植**：标点归一（其默认清除 `……`，与本项目作者偏好冲突，见 ADR-0009）、
  skill / 提示词编排、`dashboard-server.mjs`、改写执行部分
- **许可**：MIT

```
MIT License

Copyright (c) 2025-2026 oh-story-claudecode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
