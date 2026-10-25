# Vehicle Model Lab

NIO ES7 完整模型组件动效的隔离开发区。

Git 跟踪 ES7 建模脚本、schema、验证工具、隔离 viewer、署名许可、可读审计记录，以及
`dist/` 中与 HMI 资产逐字节相同的最终 GLB/manifest。大型 Blender 源场景/检查点、渲染图、
下载的源模型包、解压工作材质和其他生成导出物保留在本地并由 `.gitignore` 排除。干净克隆
包含 HMI 运行时资产和最终校验镜像，但不包含 Blender 工程源文件；重新构建时需按下方来源
和许可证说明取得源模型并准备本地工作场景。旧 Ferrari 实验和已停止的 ES8 白模路线只保留在本地开发记录中，不在本目录。

## 边界

- 正式可见资产采用 ItsDiyor 的 `Nio ES7 2023`，遵循 CC BY 4.0；完整署名见 `THIRD_PARTY_NOTICES.md`。
- 不读取、修改或导入现有 Ferrari 资产。
- 不依赖 `src/` 中的 HMI、Runtime 或 Safety 实现。
- `source/` 保存 Blender 源文件，`dist/` 保存候选导出物。
- 动效实验通过前不修改当前页面或主项目车模选择。

## 当前工作流

- `source/es7-reference.blend`：只读语义的来源审计场景；
- `source/nio-es7-animation-master.blend`：ES7 几何、组件、pivot 和动画的唯一源事实；
- `source/checkpoints/nio-es7-stage-a.blend`：A 阶段通过离线与浏览器验收后的冻结检查点；
- `source/checkpoints/nio-es7-stage-b.blend`：B 阶段通过离线与浏览器验收后的冻结检查点；
- `source/checkpoints/nio-es7-stage-b-direction-wheel-fix.blend`：前舱盖/后视镜方向与 Wheel1 重影修正后的冻结检查点；
- `source/checkpoints/nio-es7-stage-b-tailgate-wiper-fix.blend`：尾门向外上翻与双雨刷右上扫动修正后的冻结检查点；
- `source/checkpoints/nio-es7-pre-wiper-hierarchy-refinement.blend`：雨刷活动总成分件与轴心优化前的恢复检查点；
- `source/checkpoints/nio-es7-pre-dual-wiper-upward-fix.blend`：双雨刷视觉同向上扫修复前的恢复检查点；对应脚本 `correct-es7-dual-wiper-upward-sweep.py`（右雨刷 +1 局部 Z）已被 `correct-es7-tailgate-wiper-directions.py` 与契约中双雨刷 -1 取代，脚本已停用并拒绝运行；
- `source/checkpoints/nio-es7-pre-original-wiper-rigid-regroup.blend`：原模型雨刷刚性总成重组与真实轴心修正前的恢复检查点；
- `source/checkpoints/nio-es7-pre-wiper-contact-plane-calibration.blend`：雨刷贴合前风挡曲面的标定前恢复检查点；
- `source/checkpoints/nio-es7-pre-seat-components.blend`：前排座椅组件化前的恢复检查点；
- `source/checkpoints/nio-es7-pre-seat-animations.blend`：主驾四轴动效写入前的恢复检查点；
- `schema/es7-source-map.json`：原始对象到稳定组件 ID 的已确认映射；`audit-es7-components.py` 只把候选映射写入 `references/es7-cc-by/es7-source-map.candidate.json`，不覆盖该文件；
- `schema/es7-components.json`：网页、Blender 和验证脚本共用的稳定组件与动作契约；
- `references/es7-cc-by/component-audit.json`：完整对象、材质、层级和包围盒审计；
- `dist/nio-es7-animated.glb` 与 `dist/nio-es7-component-manifest.json`：A+B+C 阶段网页运行时资产；
- `viewer/`：与主 HMI 隔离的 Three.js 组件验证台；
- A 阶段已完成车门、车窗、尾门、前舱盖、门把手、轮组和灯光；B 阶段已完成充电口、左右后视镜折叠、双雨刷和车身相对车轮升高。
- C 阶段已完成主驾前后、整椅升降、靠背角度与头枕高度四轴连续调节，并提供四座清晰、其他部件低饱和半透明的聚焦演示。
- 当前正式轮组保留 `Wheel1`；其余轮毂方案及遗留静态轮胎网格均隐藏并禁止导出。当前 GLB 为 17,764,944 字节、484,418 三角面、52 个材质、7 张纹理和 25 个机械动作。

## ES7 A+B+C 阶段验证

```bash
node vehicle-model-lab/verify/verify-es7-schema.mjs
node vehicle-model-lab/verify/inspect-es7-glb-components.mjs
node vehicle-model-lab/verify/inspect-es7-glb-animations.mjs
node vehicle-model-lab/verify/verify-es7-attribution.mjs
node vehicle-model-lab/verify/verify-es7-viewer.mjs
node vehicle-model-lab/verify/test-es7-verifier-failures.mjs
```

Blender 母版另使用 `validate-es7-stage-a-animations.py`、`validate-es7-stage-b-components.py`、
`validate-es7-stage-b-animations.py`、`validate-es7-stage-b-showcase.py` 和
`audit-es7-stage-b-motion-bounds.py` 验证层级、轨道、展示序列和枢轴位移；
`validate-es7-seat-components.py` 与 `validate-es7-seat-animations.py` 验证四座分组、主驾固定轨道、四轴层级和连续动作范围；
`validate-es7-direction-wheel-fix.py` 额外验证前舱盖闭合高度/开启方向、后视镜向车尾折叠和静态轮胎残影隔离。
`validate-es7-tailgate-wiper-directions.py` 验证尾门向车外上方移动、双雨刷负局部 Z 扫动及有效位移。
`validate-es7-wiper-hierarchy.py` 验证原雨刷活动件归属、独立底部轴心、刚性扫动与无偏移回程。
双雨刷均使用负局部 Z：长雨刷绕下沿中部原臂根部轴心转动，另一支绕右下原轴心转动，两套原组件同步向左上方扫动。

浏览器验证时，从项目根目录启动临时静态服务并打开
`/vehicle-model-lab/viewer/`；验证完成后停止服务。测试页只用于实验室验收，不接入 `src/app/`。
