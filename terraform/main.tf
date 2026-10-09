terraform {
  required_version = ">= 1.7"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {
    bucket         = "srvless-api-tfstate"
    key            = "srvless-api/terraform.tfstate"
    region         = "ap-northeast-1"
    dynamodb_table = "srvless-api-tfstate-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "srvless-api"
      Environment = var.env
      ManagedBy   = "Terraform"
    }
  }
}

locals {
  prefix = "srvless-${var.env}"
  is_prd = var.env == "prd"
  log_retention = local.is_prd ? 30 : 7
}

# ── DynamoDB ──────────────────────────────────────────────
resource "aws_dynamodb_table" "items" {
  name         = "${local.prefix}-items-table"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute { name = "id"; type = "S" }

  server_side_encryption { enabled = true }
  point_in_time_recovery { enabled = local.is_prd }
  deletion_protection_enabled = local.is_prd
}

# ── IAM ───────────────────────────────────────────────────
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals { type = "Service"; identifiers = ["lambda.amazonaws.com"] }
  }
}

data "aws_iam_policy_document" "lambda_policy" {
  statement {
    sid     = "DynamoDB"
    actions = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
               "dynamodb:DeleteItem", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.items.arn]
  }
  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:*:*:*"]
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.prefix}-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda" {
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_policy.json
}

# ── Lambda ────────────────────────────────────────────────
data "archive_file" "handler" {
  type        = "zip"
  source_file = "${path.module}/../src/handler/index.py"
  output_path = "${path.module}/.build/handler.zip"
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.prefix}-item-handler"
  retention_in_days = local.log_retention
}

resource "aws_lambda_function" "handler" {
  function_name    = "${local.prefix}-item-handler"
  role             = aws_iam_role.lambda.arn
  filename         = data.archive_file.handler.output_path
  source_code_hash = data.archive_file.handler.output_base64sha256
  handler          = "index.lambda_handler"
  runtime          = "python3.12"
  architectures    = ["arm64"]
  timeout          = 29

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.items.name
      ENV        = var.env
    }
  }
  depends_on = [aws_cloudwatch_log_group.lambda]
}

# ── API Gateway HTTP API ───────────────────────────────────
resource "aws_apigatewayv2_api" "api" {
  name          = "${local.prefix}-apigw"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
  }
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/aws/apigateway/${local.prefix}-apigw"
  retention_in_days = local.log_retention
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.handler.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "items" {
  for_each  = toset(["GET /items", "POST /items", "GET /items/{id}",
                     "PUT /items/{id}", "DELETE /items/{id}"])
  api_id    = aws_apigatewayv2_api.api.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.handler.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}