# 场馆消防演练签到采集与人员清点

这里是可离线启动的合成上游，所有编号、时间和凭据都用于联调。

## 本地运行

使用 Node.js 22.23.4。项目只使用随 Node.js 提供的运行库。

```sh
npm start
npm test
```

不同终端分别启动服务和执行独立来源测试。默认地址为 `http://127.0.0.1:4173`，可设置 `SOURCE_PORT`。来源使用进程内演练时钟，启动时处于 `gather`。用 `PUT /_source_clock?step=reroute` 推进到下一阶段，`GET /_source_calls` 查看本实例收到的业务请求。可查阶段为 `gather`、`reroute`、`seal`、`catchup`、`following`。重启服务会重置时钟和请求记录。预置的源端回执按演练阶段出现，和本地应用是否已处理某次回执是两回事。
`npm test` 核对可访问的上游响应和合成资料。

## 来源约定

`/drill/rounds` 是训练轮次、台账区域与领队。 `/drill/cards` 提供牌号的分配有效区间，结束不包含边界时刻。`/devices/index` 给出端侧开机批次，`/devices/A/memory` 及 `/devices/B/memory` 返回设备还未回收的缓冲，`through` 为本批声明末序号。同步时间经 `/devices/calibration` 给出的参考区间换算，每一条校时都给上下界，跨轮次边界时不能擅取中点。 `/devices/A/replay?boot=R9&from=2&to=2` 可补领缺片。
`POST /devices/{设备}/confirm` 接收 `boot`、`through`，表示上游可回收已连续接收的原件。演练服务器在下一阶段按已确认号隐藏原缓冲，历史动作需自行留存。`/drill/transfers` 返回随员领队批准的转接与医疗点回执，按转接号连接。
