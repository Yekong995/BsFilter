# 书源筛选工具

此项目是一个书源筛选工具，旨在帮助用户从多个书源中筛选出符合特定条件的书籍。该工具使用Python+Flask编写，并通过Docker进行容器化部署，方便用户在不同环境中运行。

## 部署方式

| 部署方式 | 说明 |
| --- | --- |
| [Docker部署](#Docker部署) | 过Docker容器运行，适合在服务器或本地环境中快速部署。 |
| [本地部署](#本地部署) | 直接在本地环境中运行，适合开发和调试，当然也能够直接使用。 |

### 本地部署

1. 克隆项目到本地：
   ```bash
   git clone <repository_url>
   cd bookSource
   ```
2. 安装依赖：
   ```bash
   pip install -r requirements.txt
   ```
3. 运行应用：
   ```bash
   flask run
   ```

### Docker部署

Powershell:
```powershell
$env:BUILD_DATE = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$env:GIT_COMMIT = git rev-parse --short HEAD
docker-compose up --build -d # 直接部署使用可只看这行，上面是给有需要进行镜像构建的用户使用
```
