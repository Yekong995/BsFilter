# 书源解析结果保存在 app.py 的 _uploads 字典里（进程内存）。
# 如果开多个 worker，上传请求落在 worker A，而后续 /api/sources、/api/save
# 落到 worker B，B 的内存中没有这个 upload_id，就会返回
# “文件已过期或不存在，请重新上传”，看起来像上传的文件丢失。
# 因此这里固定单 worker，用多线程处理并发请求。
bind = "0.0.0.0:8000"
worker_class = "gthread"
workers = 1
threads = 4
accesslog = "-"
