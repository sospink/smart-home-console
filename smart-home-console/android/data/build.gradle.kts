plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.ksp)
}

android {
  namespace = "cn.zhijing.smartlab.data"
  compileSdk = 35

  defaultConfig {
    minSdk = 30
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  sourceSets.getByName("androidTest").assets.srcDir("$projectDir/schemas")
}

dependencies {
  api(libs.room.runtime)
  api(libs.room.ktx)
  implementation(libs.androidx.core.ktx)
  ksp(libs.room.compiler)
  testImplementation(libs.junit)
  androidTestImplementation(libs.junit)
  androidTestImplementation(libs.androidx.test.core)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.room.testing)
}

ksp { arg("room.schemaLocation", "$projectDir/schemas") }
