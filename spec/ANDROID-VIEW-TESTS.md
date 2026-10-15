# Activity / View 定向验收

统一使用标准 Robolectric 4.14.1 + JUnit4，`includeAndroidResources = true`。选择依据：官方兼容表4.14支持API21–35，使用的AGP8.7.1/Gradle8.10.2贴近本仓AGP8.7.3/Gradle8.11.1；API35需JDK17或更高，本仓用JDK21。无需变更生产依赖或targetSdk。

官方来源：https://robolectric.org/getting-started/ 、https://robolectric.org/compatibility_table/ 、https://github.com/robolectric/robolectric/releases/tag/robolectric-4.14.1

每个测试用 `@RunWith(RobolectricTestRunner::class)` 和 `@Config(sdk = [35], application = Application::class)`，避免启动AshApp里的宿主服务。真实Android布局、焦点、Editable/选区、Activity生命周期由Robolectric运行；端口在测试边界接本地确定性服务。不要用Model结果替代View断言，不要为测试建立第二套业务实现。

运行一个指定类：`ANDROID_HOME=/home/xiewanpeng/android-sdk ./gradlew -Dorg.gradle.java.home=/home/xiewanpeng/ashwork/jdk21 :app:testDebugUnitTest --tests ai.ash.sysapps.RobolectricResourcesTest`（工作目录android）。机器资源紧张时由总控协调串行运行，不开并发Gradle。首次运行会从标准Maven源下载测试依赖及API35沙箱。

Robolectric不证明真实IME动画、系统输入法、预测返回手势或OEM后台行为；这几项仍明确列为真机未验证。
