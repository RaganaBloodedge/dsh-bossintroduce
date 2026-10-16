import type { Context } from '@deepseek-ai/cordis';
/** 插件名（与 npm 包名一致）。 */
export declare const name = "dsh-bossintroduce";
/** 依赖的服务槽：框架会先备好 ctx.tools，再调用 apply。 */
export declare const inject: string[];
export interface Config {
    /** 数据根目录；留空 = ~/.auto-introduce（等价于环境变量 AI_HOME） */
    aiHome?: string | null;
    /** 直接指定数据目录；留空 = <aiHome>/data（等价于 AI_DATA_DIR） */
    dataDir?: string | null;
    /** CDP 端点；留空 = http://127.0.0.1:9222 */
    cdpEndpoint?: string | null;
    /** 浏览器 profile 目录；留空 = <aiHome>/edge-profile */
    browserProfile?: string | null;
    /** 每次操作后的强制静默毫秒数；留空 = 2000（**不要调小**，见 SKILL.md 铁律 4） */
    gapMs?: number | null;
    /** 浏览器可执行文件路径（msedge.exe / chrome.exe 绝对路径）；留空 = 自动发现 */
    browserPath?: string | null;
    /** Node 可执行文件路径；留空 = 自动发现（Electron 下会带 ELECTRON_RUN_AS_NODE） */
    nodePath?: string | null;
    /** Python 可执行文件路径（护栏要它）；留空 = 自动发现 */
    pythonPath?: string | null;
}
export declare function apply(ctx: Context, config?: Config): void;
