package `fun`.upup.musicfree.cacheKeepAlive

import android.content.Intent
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** 给 JS 用的开关：整曲缓存下载期间起停保活服务 */
class CacheKeepAliveModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "CacheKeepAlive"

    @ReactMethod
    fun start() {
        try {
            val intent = Intent(reactContext, CacheKeepAliveService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.startForegroundService(intent)
            } else {
                reactContext.startService(intent)
            }
        } catch (e: Exception) {
            /** Android 12+ 从后台启动前台服务会抛异常；保活失败不该让播放挂掉，退化成原来的行为 */
            Log.w("CacheKeepAlive", "启动保活服务失败: ${e.message}")
        }
    }

    @ReactMethod
    fun stop() {
        try {
            reactContext.stopService(Intent(reactContext, CacheKeepAliveService::class.java))
        } catch (e: Exception) {
            Log.w("CacheKeepAlive", "停止保活服务失败: ${e.message}")
        }
    }
}
