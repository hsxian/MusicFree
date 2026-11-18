package `fun`.upup.musicfree.cacheKeepAlive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 整曲缓存期间的保活服务。
 *
 * 缓存是「先下完再播」：下载期间没有任何播放动作，react-native-track-player 的前台服务
 * 还没起来，进程只是普通后台进程。熄屏后系统进入 Doze / App Standby，CPU 休眠、
 * 网络被掐，RNFS 的下载就停在那里，表现为「未缓存的歌一直卡住」。
 * 所以在下载期间顶一个 dataSync 前台服务 + partial wake lock，下完立刻停。
 */
class CacheKeepAliveService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MusicFree:playCache")
            .apply {
                setReferenceCounted(false)
                // 只是兜底：进程异常退出时不要让锁永久留在系统里
                acquire(WAKE_LOCK_TIMEOUT)
            }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        return START_NOT_STICKY
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "播放缓存",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                setShowBadge(false)
                enableVibration(false)
                setSound(null, null)
            }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
            return Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("缓存中")
                .setContentText("正在缓存歌曲，完成后自动播放")
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOngoing(true)
                .setShowWhen(false)
                .build()
        }
        @Suppress("DEPRECATION")
        return Notification.Builder(this)
            .setContentTitle("缓存中")
            .setContentText("正在缓存歌曲，完成后自动播放")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setShowWhen(false)
            .build()
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "musicfree.play_cache"
        private const val NOTIFICATION_ID = 4011
        /** 下载远不会这么久，仅作异常退出的兜底超时 */
        private const val WAKE_LOCK_TIMEOUT = 30 * 60 * 1000L
    }
}
