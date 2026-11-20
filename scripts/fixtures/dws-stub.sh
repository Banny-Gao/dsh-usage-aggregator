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

# 当前本地时间，格式跟真 CLI 一样：2026-11-18 17:32:07。
#
# 为什么不用数字：真 dws 的 `+at-me` 给的是 `time` 字符串、`+chat-messages` 给的
# `createTime` 也是字符串 —— 桩要是给数字，自检就守着一个真 CLI 从不产生的形状。
now_stamp() {
  node -e 'const d=new Date();const p=n=>String(n).padStart(2,"0");process.stdout.write(`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`)'
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
        stamp="$(now_stamp)"
        extra_id="${DWS_STUB_EXTRA_ID:-}"
        extra_text="${DWS_STUB_EXTRA_TEXT:-REQ-1234 的发布申请麻烦你确认一下}"
        extra_out_id="${DWS_STUB_EXTRA_OUT_ID:-}"
        extra_out_text="${DWS_STUB_EXTRA_OUT_TEXT:-楼下奶茶店今天买一送一}"
        # 两条固定消息：一条项目内（命中需求号），一条项目外。
        list='{"messageId":"msg-in-0001","conversationId":"conv-1","conversation":["项目群"],"sender":"陈世康","text":"REQ-1234 的发布申请麻烦你确认一下","time":"'"$stamp"'"},{"messageId":"msg-out-0001","conversationId":"conv-2","conversation":["前台"],"sender":"前台小妹","text":"楼下奶茶店今天买一送一","time":"'"$stamp"'"}'
        count=2
        if [ -n "$extra_id" ]; then
          # 自检第二轮用：多来一条**新**的项目内消息（新的 messageId 才会被当成新消息）。
          list="$list"',{"messageId":"'"$extra_id"'","conversationId":"conv-1","conversation":["项目群"],"sender":"陈世康","text":"'"$(json_escape "$extra_text")"'","time":"'"$stamp"'"}'
          count=3
        fi
        if [ -n "$extra_out_id" ]; then
          # 再多来一条**新**的项目外消息 —— 它该进待处理清单，但没有路由会话。
          list="$list"',{"messageId":"'"$extra_out_id"'","conversationId":"conv-4","conversation":["运维通知"],"sender":"运维机器人","text":"'"$(json_escape "$extra_out_text")"'","time":"'"$stamp"'"}'
          count=$((count + 1))
        fi
        printf '{"messages":[%s],"count":%s,"complete":true}\n' "$list" "$count"
        exit 0
        ;;

      +unread-chats)
        # 未读会话列表：会话名 + 会话 id（真 CLI 的形状）。
        printf '{"conversations":[{"conversationId":"conv-3","name":"安心筑APP错误上报群"}]}\n'
        exit 0
        ;;

      +chat-messages)
        # 读某个会话的消息：这里给一条**没 @ 我**的消息 —— 它只能靠未读会话这条路进来。
        # 正文 @ 的是别人（张弦），不是「我」—— 这就是「别人回复别人」那一类。
        chat_id="$(arg_value --conversation-id "$@" || true)"
        [ -n "$chat_id" ] || chat_id="conv-3"
        extra_chat_id="${DWS_STUB_EXTRA_CHAT_ID:-}"
        extra_chat_text="${DWS_STUB_EXTRA_CHAT_TEXT:-}"
        list='{"messageId":"msg-unread-0001","conversationId":"'"$(json_escape "$chat_id")"'","createTime":"'"$(now_stamp)"'","sender":"钟鹏","senderId":"DU7jxUQkuiPvqsdCyd2By8fypvKQALySDs","text":"@张弦 明天细聊一下，看一下这儿需不需要调整一下。"}'
        count=1
        if [ -n "$extra_chat_id" ]; then
          # 自检第二轮用：未读会话里再来一条**新的**、同样没 @ 我的消息。
          list="$list"',{"messageId":"'"$extra_chat_id"'","conversationId":"'"$(json_escape "$chat_id")"'","createTime":"'"$(now_stamp)"'","sender":"钟鹏","senderId":"DU7jxUQkuiPvqsdCyd2By8fypvKQALySDs","text":"'"$(json_escape "$extra_chat_text")"'"}'
          count=2
        fi
        printf '{"messages":[%s],"count":%s,"complete":true}\n' "$list" "$count"
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
