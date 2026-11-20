#!/usr/bin/env bash
# scripts/fixtures/dws-stub.sh
#
# 假的 dws 命令行：给「钉钉沙发」的离线自检当后端。
#
# 职责：按第一个参数分派，往 stdout 打一份 JSON，模拟自检用到的这几条命令：
#   · aisearch person --query <姓名>    —— 按姓名查人（同名要能查出两个人）
#   · chat +messages-send --content     —— 发消息，回 openTaskId（**不是消息 ID**）
#   · chat +search-msg --query <关键词> —— 回查消息；关键词里含「回执」才查得到
#   · chat +at-me --page-all            —— 拉 @我 的消息（一条项目内、一条项目外）
#   · --version                         —— 版本横幅（一行文本，不是 JSON）
#
# 原理：输出形状固定（自检要断言字段），但时间戳取运行时的当前时间（毫秒）——
# 回查与「第二轮拉到新消息」都依赖时间戳是当下，不能写死一个过期值。
# 其它命令一律退出码 1 + stderr 一行 unknown command，跟真 CLI 的失败形态一致。

set -u

# 当前毫秒时间戳。
now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

# 打印紧跟在某个 flag 后面的值；没有就非零退出。
arg_value() {
  local flag="$1"
  shift
  local prev=""
  local item
  for item in "$@"; do
    if [ "$prev" = "$flag" ]; then
      printf '%s' "$item"
      return 0
    fi
    prev="$item"
  done
  return 1
}

# JSON 字符串转义（只处理反斜杠与双引号，够用）。
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# 未知命令：stdout 不打东西，stderr 说一行，退出码非零。
unknown_command() {
  printf 'unknown command\n' >&2
  exit 1
}

command_name="${1:-}"
sub_name="${2:-}"

case "$command_name" in
  --version)
    printf 'dws 0.9.9\n'
    exit 0
    ;;

  aisearch)
    query_name="$(arg_value --query "$@" || true)"
    case "$query_name" in
      陈世康)
        printf '{"results":[{"name":"陈世康","userId":"u-1001","openDingTalkId":"odt-chen-shikang-0001","deptName":"后端组"}]}\n'
        ;;
      张伟)
        printf '{"results":[{"name":"张伟","userId":"u-2001","openDingTalkId":"odt-zhangwei-a-0002","deptName":"平台组"},{"name":"张伟","userId":"u-2002","openDingTalkId":"odt-zhangwei-b-0003","deptName":"数据组"}]}\n'
        ;;
      *)
        printf '{"results":[]}\n'
        ;;
    esac
    exit 0
    ;;

  chat)
    case "$sub_name" in
      +messages-send)
        # openTaskId 是**发送任务 ID**，不是消息 ID —— 自检要靠这个区分「已提交」与「已送达」。
        printf '{"openTaskId":"task-0001"}\n'
        exit 0
        ;;

      +search-msg)
        keyword="$(arg_value --query "$@" || true)"
        senders="$(arg_value --senders "$@" || true)"
        [ -n "$senders" ] || senders="odt-chen-shikang-0001"
        hit=0
        case "$keyword" in
          *回执*) hit=1 ;;
        esac
        if [ "$hit" = "1" ]; then
          printf '{"messages":[{"messageId":"msg-real-0001","conversationId":"conv-1","sender":"陈世康","senderId":"%s","text":"%s","createTime":%s}],"complete":true}\n' \
            "$senders" "$(json_escape "$keyword")" "$(now_ms)"
        else
          printf '{"messages":[],"complete":true}\n'
        fi
        exit 0
        ;;

      +at-me)
        stamp="$(now_ms)"
        extra_id="${DWS_STUB_EXTRA_ID:-}"
        extra_text="${DWS_STUB_EXTRA_TEXT:-REQ-1234 的发布申请麻烦你确认一下}"
        if [ -n "$extra_id" ]; then
          # 自检第二轮用：多来一条**新**的项目内消息（新的 messageId 才会被当成新消息）。
          printf '{"messages":[{"messageId":"msg-in-0001","conversationId":"conv-1","sender":"陈世康","senderId":"odt-chen-shikang-0001","text":"REQ-1234 的发布申请麻烦你确认一下","createTime":%s},{"messageId":"msg-out-0001","conversationId":"conv-2","sender":"前台小妹","senderId":"odt-frontdesk-0009","text":"楼下奶茶店今天买一送一","createTime":%s},{"messageId":"%s","conversationId":"conv-1","sender":"陈世康","senderId":"odt-chen-shikang-0001","text":"%s","createTime":%s}],"count":3,"complete":true}\n' \
            "$stamp" "$stamp" "$extra_id" "$(json_escape "$extra_text")" "$stamp"
        else
          printf '{"messages":[{"messageId":"msg-in-0001","conversationId":"conv-1","sender":"陈世康","senderId":"odt-chen-shikang-0001","text":"REQ-1234 的发布申请麻烦你确认一下","createTime":%s},{"messageId":"msg-out-0001","conversationId":"conv-2","sender":"前台小妹","senderId":"odt-frontdesk-0009","text":"楼下奶茶店今天买一送一","createTime":%s}],"count":2,"complete":true}\n' \
            "$stamp" "$stamp"
        fi
        exit 0
        ;;

      *)
        unknown_command
        ;;
    esac
    ;;

  *)
    unknown_command
    ;;
esac
