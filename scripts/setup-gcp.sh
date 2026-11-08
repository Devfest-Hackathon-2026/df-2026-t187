#!/usr/bin/env bash
# Gemini Enterprise Agent Platform (旧 Vertex AI) / Cloud Run 用のローカル Google Cloud 環境セットアップスクリプト
# 使い方:
#   npm run setup:gcp -- <GCP_PROJECT_ID>

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-global}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "エラー: gcloud コマンドが見つかりません。先に brew install --cask gcloud-cli を実行してください。" >&2
  exit 1
fi

ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
if [ -z "$ACTIVE_ACCOUNT" ]; then
  echo "==> 0. Google Cloud にログインしていないため、ブラウザ認証を開きます..."
  gcloud auth login
fi

if [ -z "$PROJECT_ID" ]; then
  CURRENT_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  if [ -n "$CURRENT_PROJECT" ] && [ "$CURRENT_PROJECT" != "(unset)" ]; then
    PROJECT_ID="$CURRENT_PROJECT"
  else
    echo "現在ログイン中のアカウントで利用可能なプロジェクト一覧:"
    gcloud projects list || true
    echo ""
    echo "使い方: npm run setup:gcp -- <GCP_PROJECT_ID> [REGION]"
    exit 1
  fi
fi

echo "==> 1. GCP プロジェクトを '${PROJECT_ID}' に設定します..."
gcloud config set project "$PROJECT_ID"

echo "==> 2. Gemini / Cloud Natural Language / Text-to-Speech / BigQuery / Firestore / Model Armor / SDP / Cloud Run API を確認・有効化します..."
gcloud services enable aiplatform.googleapis.com language.googleapis.com texttospeech.googleapis.com bigquery.googleapis.com firestore.googleapis.com modelarmor.googleapis.com dlp.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

ADC_FILE="$HOME/.config/gcloud/application_default_credentials.json"
if [ ! -f "$ADC_FILE" ]; then
  echo "==> 3. Application Default Credentials (ADC) を取得するためブラウザ認証を開きます..."
  gcloud auth application-default login
else
  echo "==> 3. Application Default Credentials (ADC) は取得済みです。"
fi

echo "==> 4. ADC のクォータプロジェクトを '${PROJECT_ID}' に設定します..."
gcloud auth application-default set-quota-project "$PROJECT_ID"

ENV_FILE=".env.local"
cat > "$ENV_FILE" <<EOF
PORT=8080
GOOGLE_CLOUD_PROJECT=${PROJECT_ID}
GOOGLE_CLOUD_LOCATION=${REGION}
GEMINI_MODEL=gemini-3.8-flash
MODEL_ARMOR_LOCATION=us-central1
MODEL_ARMOR_TEMPLATE_ID=studio-input-guard
EOF

echo ""
echo "✅ Gemini Enterprise Agent Platform 接続設定が完了しました！ (.env.local を生成しました)"
echo "   npm run dev を起動すると Gemini Enterprise Agent Platform (${PROJECT_ID} / ${REGION}) に接続されます。"
