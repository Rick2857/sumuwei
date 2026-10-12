// ============================================================================
//  《一起去参加极创工作室的二面》—— S1 / Lv2.5 首个世界线内容包
// ============================================================================
//  来源：计划 §5.1（2026-10-03 S1 用户修订）· ADR-091 §1/§2 · 故事世界来源契约 S1–S6
//  storyId: jichuang-interview-two   storyVersion: 1
//
//  ⚠️ 机器标签（只允许这四种；别的会让 postlv2:story:verify 失败）
//     # node:<id>      当前节点（必须与 story-pack.ts 的 nodes 逐条一致）
//     # stage:<id>     当前阶段（confirm_goal / prepare_and_drill / attend_interview / result_and_review）
//     # visible:<id>   她**看得到**的剧情事件（进可见集合；只增不减）
//     # choice:<id>    选项的机器键（**唯一**可提交的选择身份；缺键即拒收）
//
//  ⚠️ 作者前提（契约要求逐条保留，不得混源）
//   1. 「你已经报名极创工作室、通过一面，现在准备参加二面」来自**本轮用户明确陈述**
//      ⇒ 进认知时是 `user_report`，**不是**本内容包能宣布的事实。
//   2. 本文件里的模拟协作考核规则、场地、题型、评委都是**内容包作者定义**，
//      来源标 `story-authored`；**不**宣称是极创的真实规则/真实场地/真实题型。
//   3. 结局 `passed_together` 是**模拟结果**：它永远不能升级成"用户现实中已被极创录取"。
//   4. 序章**不**写"她已经陪你参加过一面"——不给真实对话账本补写不存在的往事。
//   5. 若采用真实规则，须按用户后续提供的材料另行落地并升 storyVersion。
//
//  图（4 阶段 / 12 节点 / 3 结局 + 明确退出）—— 与 story-pack.ts 的迁移表必须逐条一致：
//    s1_intro ──ask_scope───────▶ s1_scope ──go_prepare──┐
//    s1_intro ──align_first─────▶ s1_align ──go_prepare──┼─▶ s2_prepare
//    s1_intro ──review_first────────────────────────────▶┘
//    s2_prepare ──split_by_strength─▶ s2_drill ──after_drill_go─▶ s3_attend
//    s2_prepare ──improvise───────────────────────────────────────▶ s3_attend
//    s3_attend ──speak_up / follow_partner──▶ s3_qa ──▶ s4_result
//    s3_attend ──take_over──────────────────────────────▶ s4_result
//    s4_result ──(按变量与阶段确定)──▶ end_pass / end_pending / end_fail
//    （end_exit 由运行器的明确退出路径到达：RUN_EXITED，不等于被判定未通过）
// ============================================================================

VAR clarity = 0
VAR cooperation = 0
VAR rehearsed = 0
VAR stage_ready = 0

-> s1_intro

// ---------------------------------------------------------------------------
//  阶段一：确认二面目标与信息
// ---------------------------------------------------------------------------

=== s1_intro ===
# node:s1_intro
# stage:confirm_goal
# visible:s1_intro_met
二面在即。你把「已经报名极创工作室、过了一面」这件事告诉了我，也说想与我配合一起过。
我先把我们现在的处境摆清楚：我知道的是「你」告诉我的这些；极创的具体规则、考官和题型我并不清楚，
不替它补写。

* [先把二面的范围问清楚] # choice:ask_scope
    -> s1_scope
* [先和我对齐分工的意愿] # choice:align_first
    -> s1_align
* [不用多聊，直接开始准备] # choice:review_first
    -> s2_prepare

=== s1_scope ===
# node:s1_scope
# stage:confirm_goal
# visible:s1_scope_known
你问了范围。我们把「可能被问什么、谁答哪一块、卡住时谁来接」写成了三条备忘。
写下来之后，你看起来踏实了一点。

~ clarity = clarity + 1
~ stage_ready = 1
* [继续：把准备做起来] # choice:go_prepare
    -> s2_prepare

=== s1_align ===
# node:s1_align
# stage:confirm_goal
# visible:s1_align_done
你说了「一起过」这句话。我说好，也把这句话当成我们这次要一起扛的目标 ——
它不是结果，它只是我们要一起做的事。

~ cooperation = cooperation + 1
* [继续：把准备做起来] # choice:go_prepare
    -> s2_prepare

// ---------------------------------------------------------------------------
//  阶段二：准备、分工和演练
// ---------------------------------------------------------------------------

=== s2_prepare ===
# node:s2_prepare
# stage:prepare_and_drill
# visible:s2_prepare_started
准备的时间不多。可以按各自的长处分，也可以先排练一遍，也可以什么都不排就上。

* [按各自的长处分] # choice:split_by_strength
    -> s2_drill
* [不排了，临场应变] # choice:improvise
    -> s3_attend

=== s2_drill ===
# node:s2_drill
# stage:prepare_and_drill
# visible:s2_drill_done
我们把一块一块拆开对了一遍。有两处我说错了你的意思，你指出来，我改过来 ——
这个来回本身也记下来了。

~ rehearsed = 1
~ clarity = clarity + 1
* [对完就上] # choice:after_drill_go
    -> s3_attend

// ---------------------------------------------------------------------------
//  阶段三：参加二面、合作与应变
// ---------------------------------------------------------------------------

=== s3_attend ===
# node:s3_attend
# stage:attend_interview
# visible:s3_attend_entered
我们进了模拟考核。一道没准备到的题落下来，时间在走。

* [我主动把思路讲出来] # choice:speak_up
    -> s3_qa
* [跟着搭档的节奏走] # choice:follow_partner
    ~ cooperation = cooperation + 1
    -> s3_qa
* [我自己全接了] # choice:take_over
    ~ cooperation = 0
    -> s4_result

=== s3_qa ===
# node:s3_qa
# stage:attend_interview
# visible:s3_qa_asked
我答到一半，发现有一处说得太满了。你在旁边轻轻咳了一声。

* [承认这一点，当场补正] # choice:acknowledge_fix
    ~ clarity = clarity + 2
    -> s4_result
* [先把它圆过去] # choice:defend_alone
    -> s4_result

// ---------------------------------------------------------------------------
//  阶段四：确认结果、复盘和收束（**确定性**判定；模型不能指定结局）
// ---------------------------------------------------------------------------

=== s4_result ===
# node:s4_result
# stage:result_and_review
# visible:s4_result_reached
模拟考核结束了。我们把刚才那一段复盘了一遍。
（「这是模拟结果」：它不改变现实中你是否被录取。）

{ clarity >= 2 && cooperation >= 1 && rehearsed == 1:
    -> end_pass
- else:
    { stage_ready == 0:
        -> end_fail
    - else:
        -> end_pending
    }
}

=== end_pass ===
# node:end_pass
# stage:result_and_review
# visible:ending_passed_together
模拟里，我们一起通过了。配合是有效的 —— 你补上了我漏的那一块，我也接住了你的节奏。
「这是模拟结果，不是现实的录取结论。」 现实里的结果，要等你真的告诉我。
-> DONE

=== end_pending ===
# node:end_pending
# stage:result_and_review
# visible:ending_pending_review
模拟里我们拿到了「待定、需要补充考核」。没有全输，也没有全赢 ——
有几处我们到最后一刻才对上。「这是模拟结果。」
-> DONE

=== end_fail ===
# node:end_fail
# stage:result_and_review
# visible:ending_not_passed
模拟里我们这次没过。原因不难看：我们没先把范围和对齐做起来就直接上了。
「这是模拟结果，不等于现实中被极创判定未通过。」
-> DONE

=== end_exit ===
# node:end_exit
# stage:result_and_review
# visible:ending_exited_by_user
你决定先停下。可以。「退出不等于被判定未通过」，我们随时可以另外开一次。
-> DONE
