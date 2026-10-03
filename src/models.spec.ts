import {
  applyMaterialStatus,
  captionSafeAreaOk,
  createDemoProject,
  ingestReturnRows,
  migrateProject,
  type CourseProject,
  type DemoMaterial,
  type ReturnRow,
} from './models';

function legacyProject(): CourseProject {
  const project = createDemoProject();
  const raw = JSON.parse(JSON.stringify(project)) as Record<string, unknown>;
  delete raw.shootTasks;
  delete raw.materials;
  delete raw.suspendedReturns;
  delete raw.nextTaskSeq;
  (raw.modules as CourseProject['modules']).forEach((module) => module.steps.forEach((step) => {
    const legacy = step as unknown as Record<string, unknown>;
    delete legacy.shootTaskNo;
    delete legacy.materialId;
    delete legacy.materialReview;
  }));
  return raw as unknown as CourseProject;
}

describe('拍摄任务与素材回传', () => {
  it('演示项目里每个示范步骤都开了一条拍摄任务', () => {
    const project = createDemoProject();
    const steps = project.modules.flatMap((module) => module.steps);
    expect(project.shootTasks).toHaveLength(steps.length);
    steps.forEach((step) => {
      expect(step.shootTaskNo).toMatch(/^ST-\d{4}$/);
      expect(project.shootTasks.some((task) => task.taskNo === step.shootTaskNo && task.stepId === step.id)).toBe(true);
    });
    expect(project.nextTaskSeq).toBe(steps.length + 1);
  });

  it('回传对不上的只挂起这几条，对上的照常入库，且压不到教师字段', () => {
    const project = createDemoProject();
    const step = project.modules[0].steps[1]; // step-1-2，任务 ST-0002
    const before = { caption: step.caption, altText: step.altText, exercise: step.exercise, exerciseFeedback: step.exerciseFeedback };
    const rows: ReturnRow[] = [
      { key: 'a', taskNo: 'ST-0002', name: '你好 · 手部近景', url: 'assets/hello-hands.mp4', camera: '俯拍手部' },
      { key: 'b', taskNo: 'ST-9999', name: '不存在的任务', url: '', camera: '正面' },
      { key: 'c', taskNo: 'ST-0003', name: '', url: '', camera: '正面' },
    ];
    const { project: next, outcome } = ingestReturnRows(project, rows, 'batch-1');

    expect(outcome.applied).toHaveLength(1);
    expect(outcome.suspended).toHaveLength(2);
    expect(outcome.suspended.map((row) => row.key)).toEqual(['b', 'c']);
    expect(outcome.suspended[0].reason).toContain('ST-9999');

    const updated = next.modules[0].steps[1];
    expect(updated.demoUrl).toBe('assets/hello-hands.mp4');
    expect(updated.camera).toBe('俯拍手部');
    // 回传压不到教师填的字幕、替代文本与练习
    expect(updated.caption).toBe(before.caption);
    expect(updated.altText).toBe(before.altText);
    expect(updated.exercise).toBe(before.exercise);
    expect(updated.exerciseFeedback).toBe(before.exerciseFeedback);
    // 新素材机位与字幕位置冲突，按新素材重判后退回待确认
    expect(updated.materialReview).toBe('待确认');
    const task = next.shootTasks.find((item) => item.taskNo === 'ST-0002');
    expect(task?.status).toBe('已回传');
    expect(task?.materialId).toBe(updated.materialId);
  });

  it('失败后只重试挂起的这几条', () => {
    const project = createDemoProject();
    const rows: ReturnRow[] = [
      { key: 'a', taskNo: 'ST-0003', name: '双人练习素材', url: 'assets/pair.mp4', camera: '全身远景' },
      { key: 'b', taskNo: 'ST-9999', name: '编号写错', url: '', camera: '正面' },
    ];
    const first = ingestReturnRows(project, rows, 'batch-1');
    expect(first.outcome.suspended).toHaveLength(1);

    // 修正挂起条目的编号后重试，只处理挂起条目
    const fixed = first.outcome.suspended.map((row) => ({ ...row, taskNo: 'ST-0005' }));
    const second = ingestReturnRows(first.project, fixed, 'retry-1');
    expect(second.outcome.applied).toHaveLength(1);
    expect(second.outcome.suspended).toHaveLength(0);
    expect(second.project.shootTasks.find((task) => task.taskNo === 'ST-0005')?.status).toBe('已回传');
    // 第一次已入库的素材不被重复处理
    expect(second.project.materials.filter((material) => material.taskNo === 'ST-0003')).toHaveLength(1);
  });

  it('素材标为停用或重拍后，引用步骤按新素材重判字幕安全区，不达标退回待确认', () => {
    const project = createDemoProject();
    const step = project.modules[0].steps[0]; // step-1-1，引用 mat-st-0001
    const materialId = step.materialId;
    expect(materialId).toBeTruthy();

    // 安全区达标的步骤保持已确认
    const ok = applyMaterialStatus(project, materialId, '停用');
    expect(ok.project.modules[0].steps[0].materialReview).toBe('已确认');
    expect(ok.pendingStepIds).toHaveLength(0);

    // 字幕压到动作区的步骤退回待确认
    const risky = createDemoProject();
    risky.modules[0].steps[0].captionPosition = '画面中央';
    risky.modules[0].steps[0].gestureZone = '中央';
    const flagged = applyMaterialStatus(risky, materialId, '重拍');
    expect(flagged.project.modules[0].steps[0].materialReview).toBe('待确认');
    expect(flagged.pendingStepIds).toEqual(['step-1-1']);
    // 重拍会把任务退回待拍摄
    expect(flagged.project.shootTasks.find((task) => task.taskNo === 'ST-0001')?.status).toBe('待拍摄');
    expect(flagged.project.materials.find((material) => material.id === materialId)?.status).toBe('重拍');
  });
});

describe('旧数据升级', () => {
  it('没有拍摄任务编号的旧数据按示范片段名称回填任务与素材', () => {
    const legacy = legacyProject();
    const material: DemoMaterial = {
      id: 'mat-legacy-1',
      taskNo: '',
      name: '你好 · 正面慢速示范',
      url: 'assets/hello-front.mp4',
      camera: '正面',
      status: '可用',
      returnedAt: new Date().toISOString(),
    };
    (legacy as unknown as Record<string, unknown>).materials = [material];

    const migrated = migrateProject(legacy);
    const steps = migrated.modules.flatMap((module) => module.steps);
    expect(migrated.shootTasks).toHaveLength(steps.length);
    steps.forEach((step) => expect(step.shootTaskNo).toMatch(/^ST-\d{4}$/));
    expect(migrated.nextTaskSeq).toBe(steps.length + 1);

    // 按现有示范片段名称回填素材与机位
    const matched = migrated.modules[0].steps[0];
    expect(matched.materialId).toBe('mat-legacy-1');
    expect(matched.demoUrl).toBe('assets/hello-front.mp4');
    const task = migrated.shootTasks.find((item) => item.taskNo === matched.shootTaskNo);
    expect(task?.status).toBe('已回传');
    expect(task?.materialId).toBe('mat-legacy-1');

    // 没有同名素材的步骤只补任务，不强行关联
    const unmatched = migrated.modules[0].steps[1];
    expect(unmatched.materialId).toBe('');
    expect(unmatched.materialReview).toBe('已确认');
  });

  it('字幕安全区判定与发布前检查一致', () => {
    expect(captionSafeAreaOk({ captionPosition: '画面中央', gestureZone: '中央', camera: '正面' })).toBe(false);
    expect(captionSafeAreaOk({ captionPosition: '画面中央', gestureZone: '左侧', camera: '俯拍手部' })).toBe(false);
    expect(captionSafeAreaOk({ captionPosition: '画面中央', gestureZone: '左侧', camera: '正面' })).toBe(true);
    expect(captionSafeAreaOk({ captionPosition: '下方安全区', gestureZone: '中央', camera: '俯拍手部' })).toBe(true);
  });
});
