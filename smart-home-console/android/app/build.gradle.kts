import org.gradle.api.tasks.Sync

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
}

val deliveryVersionCode = providers.gradleProperty("SMART_LAB_VERSION_CODE").orNull?.toIntOrNull() ?: 1
val deliveryVersionName = providers.gradleProperty("SMART_LAB_VERSION_NAME").orNull ?: "0.1.0"
require(deliveryVersionCode > 0) { "SMART_LAB_VERSION_CODE 必须是正整数" }
require(deliveryVersionName.matches(Regex("[0-9A-Za-z][0-9A-Za-z._-]{0,39}"))) {
  "SMART_LAB_VERSION_NAME 格式无效"
}

android {
  namespace = "cn.zhijing.smartlab"
  compileSdk = 35

  defaultConfig {
    applicationId = "cn.zhijing.smartlab"
    minSdk = 30
    targetSdk = 35
    versionCode = deliveryVersionCode
    versionName = deliveryVersionName
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    val uiUpdatePublicKey = providers.gradleProperty("SMART_LAB_UI_UPDATE_PUBLIC_KEY").orNull.orEmpty()
    require(uiUpdatePublicKey.isEmpty() || uiUpdatePublicKey.matches(Regex("[A-Za-z0-9+/=]+"))) {
      "SMART_LAB_UI_UPDATE_PUBLIC_KEY 必须是 Base64 编码的 Ed25519 X.509 公钥"
    }
    buildConfigField("String", "UI_UPDATE_PUBLIC_KEY", "\"$uiUpdatePublicKey\"")
  }

  signingConfigs {
    create("release") {
      val storePath = providers.gradleProperty("SMART_LAB_KEYSTORE_FILE").orNull
      if (storePath != null) {
        storeFile = file(storePath)
        storePassword = providers.gradleProperty("SMART_LAB_KEYSTORE_PASSWORD").orNull
        keyAlias = providers.gradleProperty("SMART_LAB_KEY_ALIAS").orNull
        keyPassword = providers.gradleProperty("SMART_LAB_KEY_PASSWORD").orNull
      }
    }
  }

  buildTypes {
    debug {
      applicationIdSuffix = ".debug"
      versionNameSuffix = "-debug"
    }
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      if (providers.gradleProperty("SMART_LAB_KEYSTORE_FILE").isPresent) signingConfig = signingConfigs.getByName("release")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  buildFeatures { buildConfig = true }
}

val webRoot = rootProject.projectDir.parentFile
val buildPanelUi by tasks.registering(Exec::class) {
  workingDir = webRoot
  commandLine("pnpm", "--filter", "@smart-lab/panel-ui", "build")
  inputs.files(fileTree("${webRoot}/apps/panel-ui/src"), fileTree("${webRoot}/apps/panel-ui/public"))
  inputs.files("${webRoot}/apps/panel-ui/package.json", "${webRoot}/pnpm-lock.yaml")
  outputs.dir("${webRoot}/apps/panel-ui/dist")
}

// Sync 而非 Copy：每次打包前移除上一版带哈希的 JS/CSS，避免 APK 累积无用前端产物。
val syncPanelUi by tasks.registering(Sync::class) {
  dependsOn(buildPanelUi)
  from("${webRoot}/apps/panel-ui/dist")
  into("src/main/assets/panel-ui")
}

tasks.named("preBuild").configure { dependsOn(syncPanelUi) }

dependencies {
  implementation(project(":edgecore"))
  implementation(project(":data"))
  implementation(project(":gateway-home-assistant"))
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.ktx)
  implementation(libs.androidx.webkit)
  implementation(libs.androidx.lifecycle.service)
  testImplementation(libs.junit)
  androidTestImplementation(libs.androidx.test.core)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.tink.android)
}
