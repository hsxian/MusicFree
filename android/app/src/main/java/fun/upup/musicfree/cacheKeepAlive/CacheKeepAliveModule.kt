package `fun`.upup.musicfree.cacheKeepAlive

import android.content.Intent
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** 给 JS 用的开关：整曲缓存下载期间起停保活服务 */
class CacheKeepAliveModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "CacheKeepAlive"

    /**
     * 起不来就把原因交回 JS：Android 12+ 的后台启动限制、厂商 ROM 的省电策略都会让
     * startForegroundService 抛异常，此时只能退化成「不做后台缓存，直接播」，
     * 不能静默失败让用户对着卡住的进度条干等。
     */
    @ReactMethod
    fun start(promise: Promise) {
        try {
            val intent = Intent(reactContext, CacheKeepAliveService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.startForegroundService(intent)
            } else {
                reactContext.startService(intent)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            Log.w(TAG, "启动保活服务失败: ${e.message}")
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun stop() {
        try {
            reactContext.stopService(Intent(reactContext, CacheKeepAliveService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "停止保活服务失败: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "CacheKeepAlive"
    }
}
