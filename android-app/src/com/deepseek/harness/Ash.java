package com.deepseek.harness;

/**
 * ash 分叉的身份常量。
 *
 * Java 包名沿用上游的 com.deepseek.harness（R 类与全部源码不动，方便跟进上游），
 * 应用 ID 在打包时由 aapt --rename-manifest-package 改成 {@link #APP_ID}。
 * 端口与外部目录都与 DSH 正式版 / Lite / 兼容版错开，允许同机共存。
 */
final class Ash {
    static final String APP_ID = "ai.ash.agent";
    /** 引擎端口；通知端口 = +1，无障碍端口 = +101（与上游口径一致）。 */
    static final int ENGINE_PORT = 3090;
    /** 外部存储目录名（日志镜像、截图、定时任务记录）。 */
    static final String EXT_DIR = "Ash";

    private Ash() {}

    static boolean is(String pkg) {
        return pkg != null && pkg.startsWith("ai.ash");
    }
}
