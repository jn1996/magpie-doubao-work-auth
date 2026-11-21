/**
 * 每日签到。
 *
 * **只读，绝对不要改成写入。** 这不只是「签不上」的问题，是会**吃掉用户当天额度**的。
 *
 * 实测代价（2026-11-20）：账号当天还没签，在插件里发了一次
 * `POST /alice/ug/campaign/landing/checkin` 拿到 `710010702`。表面上看服务端状态没变
 * （`checked_in_today` 仍是 false、`task_status` 仍是 1），但之后用户去豆包客户端点签到，
 * 弹「当前暂不符合领取条件」——服务端内部已经把今天这一次消耗掉了，当天额度作废。
 *
 * 也就是说：**失败写入不是无副作用的探测**。它不可回滚、不可补救，用户只能等第二天。
 * 任何「先试试看能不能签」的想法都会直接造成损失，不要试。
 *
 * 为什么 Web 侧签不了：
 *  - 网页端根本没有签到按钮。账号菜单 →「免费用豆包工作」弹出的窗口里只有
 *    「立即下载电脑版」，写明「每天签到领 200 额度」。
 *  - 直接调接口一律 `710010702`，换 `item/reward/claim/` 则回 `biz_error.code: 3`。
 *
 * 所以这里只读状态、不做任何写入。要签到请让用户去豆包电脑版点。
 */
import { ProviderError } from './errors.mjs'

/** 签到活动组兜底值。实际以 launch 返回的为准 */
export const CAMPAIGN_SCENE = 'pc_incentive_task_mvp_v3'
/** 签到任务的 campaign_code */
export const SIGNIN_TASK = 'daily_signin'
const DETAIL_PATH = '/alice/ug/campaign/v3/detail/'

/** 从 launch 里读这个账号实际投放的活动组 */
export function campaignGroup(launch) {
  return String(launch?.ug_campaign_info?.campaign_group_code ?? '').trim()
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 从活动详情里读签到状态。
 *
 * 优先找 `daily_signin`；找不到时退而找任何一个带 `daily_checkin` 的任务。
 * @returns {{ found: boolean, claimed?: boolean, points?: number, streak?: number, claimable?: boolean, status?: number }}
 */
export function readCheckin(detail) {
  const data = detail?.data ?? detail
  const tasks = Array.isArray(data?.tasks) ? data.tasks
    : Array.isArray(data?.campaign_group?.tasks) ? data.campaign_group.tasks
      : []
  const withDaily = tasks.filter((t) => t?.campaign_code && t?.daily_checkin)
  const task = withDaily.find((t) => t.campaign_code === SIGNIN_TASK) ?? withDaily[0]
  if (!task) return { found: false }

  const daily = task.daily_checkin
  // task_status 2 才是可领取；1 是「未满足条件」，daily_signin 没投放时就是 1
  const status = Number(task.task_status)
  return {
    found: true,
    group: String(task.campaign_group_code ?? CAMPAIGN_SCENE),
    claimed: daily.checked_in_today === true,
    points: num(daily.reward?.reward_amount),
    streak: num(daily.continuous_days),
    lastDate: daily.last_checkin_date ? String(daily.last_checkin_date) : undefined,
    claimable: status === 2,
    status,
  }
}

/**
 * 报告签到状态，不发领取请求。
 * @returns magpie 的 checkin 结果：{ outcome, credit?, streak?, message? }
 */
export async function checkin(session) {
  try {
    await session.ready()

    // 先读这个账号实际投放的活动组。没投放的账号 launch 返回空字符串，
    // 直接拿常量去请求会得到 campaign not found。
    let group = campaignGroup(session.launch)
    if (!group) {
      try { group = campaignGroup(await session.json('/alice/user/launch', {})) }
      catch { /* 下面按未投放处理 */ }
    }
    if (!group) {
      return { outcome: 'inactive', message: '这个账号当前没有投放签到活动' }
    }

    let state
    try {
      state = readCheckin(await session.json(DETAIL_PATH, { campaign_group_code: group }))
    } catch (error) {
      if (error instanceof ProviderError && error.signIn) {
        return { outcome: 'failed', message: `登录已失效：${error.message}` }
      }
      const text = String(error?.message || '')
      if (/campaign not found/i.test(text)) {
        return { outcome: 'inactive', message: '这个账号当前没有投放签到活动' }
      }
      return { outcome: 'failed', message: `查询签到状态失败：${text.slice(0, 240)}` }
    }

    if (!state.found) return { outcome: 'inactive', message: '活动里没有每日签到任务' }

    const credit = state.points !== undefined ? { credit: state.points } : {}
    const streak = state.streak !== undefined ? { streak: state.streak } : {}

    if (state.claimed) {
      return { outcome: 'done', ...credit, ...streak, message: `今天已签到${state.streak ? `，连续 ${state.streak} 天` : ''}` }
    }
    if (!state.claimable) {
      return {
        outcome: 'ineligible',
        ...credit, ...streak,
        message: '今日签到暂不可领：豆包按账号投放这个活动，你的账号当前没被投放',
      }
    }
    return {
      outcome: 'ineligible',
      ...credit, ...streak,
      message: '今日未签。豆包把领取限死在电脑版客户端，请在那里点一下',
    }
  } catch (error) {
    return { outcome: 'failed', message: String(error?.message || error).slice(0, 300) }
  }
}

export const _internal = { DETAIL_PATH, campaignGroup }
