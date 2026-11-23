FROM python:3.15

ARG BUILD_DATE
ARG GIT_COMMIT

# set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .

# install python dependencies
RUN pip install --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

COPY ./gunicorn.conf.py .
COPY ./app.py .
COPY ./templates ./templates
COPY ./static ./static

EXPOSE 8000
# gunicorn
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app:app"]
