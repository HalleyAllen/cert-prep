import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { now, owner } from './store.mjs';
import { localDay, saveSchedule, shiftDay } from './planner.mjs';
import { insertQuestion, openAttempt, submitAttempt } from './study.mjs';

const lessons = [
  ['项目与项目管理', '项目是一项为创造独特产品、服务或成果而开展的临时性工作。临时性意味着项目具有明确的开始和结束，成果则可能长期存在。日常运营通常是持续且重复的活动。', '项目的临时性', '关注工作是否有明确的结束条件，成果能否长期使用是另一个问题。', '下列哪项最符合项目的特征？', ['每天处理客户咨询', '按计划迁移一套旧系统', '持续运营客服中心'], [1]],
  ['范围与工作分解结构', '范围说明交付内容和边界。工作分解结构（WBS）以可交付成果为导向，对项目工作逐层分解。工作包是可用于估算成本和安排进度的低层工作单元。', 'WBS 的分解对象', '把交付成果分解成可管理的工作包，再据此安排活动。', 'WBS 的主要分解对象是什么？', ['可交付成果及项目工作', '员工绩效指标', '仅项目日历'], [0]],
  ['进度与关键路径', '关键路径是进度网络中决定项目最短工期的最长路径。关键路径上的活动通常没有总浮动时间。压缩非关键路径上的活动通常不会缩短项目总工期。', '关键路径与总工期', '先识别决定完工时间的路径，再判断压缩哪项活动有用。', '关键路径通常直接决定什么？', ['项目最短工期', '项目团队规模', '验收材料格式'], [0]],
  ['风险识别与应对', '风险是不确定事件或条件，发生时可能对项目目标产生正面或负面影响。威胁可通过规避、转移、减轻或接受等策略应对。问题是已经发生且需要处理的事项。', '风险和问题的区别', '用“尚未确定发生”和“已经发生”区分风险与问题。', '下列哪些可作为威胁应对策略？', ['规避', '减轻', '忽略所有记录'], [0, 1]],
  ['沟通与干系人参与', '干系人是可能影响项目、受到项目影响或认为自己受到项目影响的人或组织。沟通计划应描述所需信息、接收者、渠道和频率，并随需要调整。', '沟通计划的要素', '为不同接收者明确所需信息、传递渠道和频率。', '沟通计划可以随项目需要调整。', ['正确', '错误'], [0]],
  ['质量与验收', '质量关注交付物满足需求的程度。验收以约定的验收标准和证据为依据，应在交付过程中持续收集证据并记录结论。', '验收依据', '用事先约定的标准和可检查的证据评价交付物。', '验收主要依据什么？', ['项目群聊的活跃度', '约定的标准与交付证据', '团队成员的个人偏好'], [1]],
];

export function seedDemo(store, root) {
  if (store.get('SELECT id FROM certificates WHERE owner=? LIMIT 1', owner)) return;
  const today = localDay();
  const at = now();
  const cert = { id: 'demo', exam_date: shiftDay(today, 32) };
  store.transaction(() => {
    store.run('INSERT INTO certificates(id, owner, name, exam_date, demo, updated_at) VALUES (?, ?, ?, ?, 1, ?)',
      cert.id, owner, '项目管理基础', cert.exam_date, at);
    for (const [index, name] of ['项目管理知识', '项目实务'].entries()) {
      const course = `demo-course-${index + 1}`;
      const material = `demo-material-${index + 1}`;
      const subset = lessons.slice(index * 3, index * 3 + 3);
      store.run('INSERT INTO courses VALUES (?, ?, ?, ?)', course, cert.id, name, index + 1);
      writeFileSync(join(root, 'uploads', `${material}.txt`), subset.map((lesson, position) => `第${index * 3 + position + 1}章 ${lesson[0]}\n${lesson[1]}`).join('\n\n'));
      store.run('INSERT INTO materials VALUES (?, ?, ?, ?, ?, 1, ?)', material, course, `${name} · 示例讲义.txt`, '.txt', `${material}.txt`, at);
      for (const [position, [title, text, point, hint, stem, options, answer]] of subset.entries()) {
        const chapterId = `demo-chapter-${index * 3 + position + 1}`;
        const analysis = { sections: [{ summary: text, points: [{ kind: 'key', title: point, explanation: hint, units: [position + 1] }] }], generatedAt: at };
        store.run('INSERT INTO units VALUES (?, ?, NULL, ?, ?, ?)', material, position + 1, text, 'text', title);
        store.run(`INSERT INTO chapters (id, course_id, material_id, title, start_unit, end_unit, position, analysis, learned_at, visited_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, chapterId, course, material, title, position + 1, position + 1, position + 1,
        JSON.stringify(analysis), index === 0 && position < 2 ? at : null, index === 0 && position === 1 ? at : null);
        insertQuestion(store, chapterId, { kind: options.length === 2 ? 'boolean' : answer.length > 1 ? 'multiple' : 'single',
          stem, options, answer, explanation: hint }, { type: 'demo' }, true);
      }
    }
    saveSchedule(store, cert, { weekdays: [0, 1, 2, 3, 4, 5, 6], minutes: 45 }, today);
  });
  const attempt = openAttempt(store, cert, { id: 'demo-chapter-1' }, 'chapter');
  submitAttempt(store, cert.id, attempt.id, { [attempt.questions[0].id]: [0] });
  store.run('UPDATE chapters SET visited_at=NULL WHERE id=?', 'demo-chapter-1');
}
