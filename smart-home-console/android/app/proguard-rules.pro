-keepattributes RuntimeVisibleAnnotations,AnnotationDefault,InnerClasses,EnclosingMethod,Signature
-keep class kotlinx.serialization.** { *; }
-keep class io.ktor.** { *; }
-dontwarn org.slf4j.**
# Ktor server 包含仅供桌面 JVM 热重载/IDE 调试探测的可选引用；Android 正式运行时不调用这些路径。
-dontwarn com.sun.nio.file.SensitivityWatchEventModifier
-dontwarn java.lang.management.ManagementFactory
-dontwarn java.lang.management.RuntimeMXBean
