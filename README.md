# CRM 学情异常助手

Chrome / Edge Manifest V3 扩展，用于在深空 CRM 工作台汇总当前教师在读营期中的旷课、课后作业未完成、课后拓展未完成和调课学员。

## 数据来源

- 常驻班级：自动读取“用户学情”的只读接口 `/live/learning-situation/searchLearningSituationList`。
- 本次上课班级、到课和作业：读取“教学期”的只读接口 `/live/class-user/teachSearch`。
- 课次数据更新时间：读取 `/live/class-user/teachTotal` 返回的课次专属 `updateTime`。
- 课次与班级时段：读取营期课程和班级信息接口。
- 匹配主键：CRM 学员 `userId`，不使用姓名推断。
- Excel/CSV 仅作为历史班级或时段修正，不再是使用扩展的前置条件。

扩展不会保存 CRM 密码或登录令牌，不调用 CRM 写接口。常驻班级修正、永久转班覆盖和 15 分钟异常缓存只保存在当前浏览器的 `chrome.storage.local` 中。

## 安装

1. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本目录 `crm-learning-alert-extension`。
5. 重新加载 `https://sk-crm.codemao.cn/workbar`，等待 CRM 表格出现。
6. 点击页面右侧“学情异常”。

首次加载扩展后必须刷新 CRM，使只读请求捕获脚本在页面接口请求之前启动。

## 判定规则

- 旷课：课次结束次日 20:00 后，CRM 数据也已更新到该时间，且 `attendFlag` 为未到课。
- 作业未完成：读取教学期“课后作业”列，创作题、OJ 题或客观题中任一已布置题型的通过数小于总数；`0/0` 忽略。
- 拓展未完成：独立读取教学期“课后拓展”列，以通过数小于拓展题目总数判定；题目数量动态读取，不限制为两道。
- 调课：用户学情常驻班级与该课次教学期班级不同，且 CRM `adjustmentState` 表示调课或已完成。
- 待确认：两个班级不同，但 CRM 调课状态仍为正常。
- 数据更新时间或课次结束时间缺失时不生成旷课/作业结论。
- 月份筛选：按课次时间归入月份，默认展示数据中最近的月份；可切换任意月份或“全部月份”。
- 异常明细按课次结束时间倒序，最新课次始终在最上方；时间缺失的记录排在最后。
- “复制当前结果 ID”会复制当前筛选范围内的去重学员 ID，便于按月份和异常类型群发通知。
- 作业和拓展分别显示每种题型的未通过数量及“通过数/总数”，不再用提交数代替完成状态。

## 修正名单

可选的 `.xlsx` / `.csv` 文件必填列：

```text
学员ID,原班级编号,原上课时段
```

可选列为 `学员姓名`。示例见 `examples/名单修正模板.csv`。重复 ID、空字段和格式错误会在导入时阻止保存。

## 测试

在 PowerShell 中运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\serve.ps1 -Port 8765
```

然后打开：

- `http://127.0.0.1:8765/tests/index.html`：规则与适配器测试。
- `http://127.0.0.1:8765/tests/mock.html`：桌面和窄屏界面预览。

接口字段变化时优先修改 `src/crm-adapter.js` 和 `src/page-bridge.js`，名单格式与异常规则无需改变。
