export type CourseStatus = 'draft' | 'review' | 'changes' | 'frozen';
export type Difficulty = '入门' | '进阶' | '挑战';
export type CameraAngle = '正面' | '左侧 45°' | '右侧 45°' | '俯拍手部' | '全身远景';
export type CaptionPosition = '下方安全区' | '上移 15%' | '角标提示' | '画面中央';
export type GestureZone = '左侧' | '中央' | '右侧';
export type ShootTaskStatus = '待拍摄' | '已回传';
export type MaterialStatus = '可用' | '停用' | '重拍';
export type MaterialReview = '已确认' | '待确认';

export interface LessonStep {
  id: string;
  title: string;
  kind: '示范' | '讲解' | '练习';
  duration: number;
  demoTitle: string;
  demoUrl: string;
  handshape: string;
  gestureZone: GestureZone;
  caption: string;
  captionPosition: CaptionPosition;
  camera: CameraAngle;
  commonMistakes: string[];
  exercise: string;
  exerciseFeedback: string;
  altText: string;
  prerequisiteId: string;
  difficulty: Difficulty;
  cuePoints: number[];
  /** 拍摄任务编号：教师每加一个示范步骤就开一条拍摄任务 */
  shootTaskNo: string;
  /** 当前引用的示范素材 */
  materialId: string;
  /** 素材停用/重拍后按新素材重判字幕安全区的确认状态 */
  materialReview: MaterialReview;
}

export interface CourseModule {
  id: string;
  title: string;
  summary: string;
  color: string;
  steps: LessonStep[];
}

/** 拍摄组持有的拍摄任务，按任务编号回传素材 */
export interface ShootTask {
  id: string;
  taskNo: string;
  stepId: string;
  moduleId: string;
  clipName: string;
  status: ShootTaskStatus;
  materialId: string;
  createdAt: string;
}

/** 拍摄组回传的示范素材与机位 */
export interface DemoMaterial {
  id: string;
  taskNo: string;
  name: string;
  url: string;
  camera: CameraAngle;
  status: MaterialStatus;
  returnedAt: string;
}

/** 一条待回传的素材记录 */
export interface ReturnRow {
  key: string;
  taskNo: string;
  name: string;
  url: string;
  camera: CameraAngle | '';
}

/** 对不上任务编号而被挂起的回传，重试时只处理这些 */
export interface SuspendedReturn extends ReturnRow {
  reason: string;
  batchId: string;
}

export interface FrozenVersion {
  id: string;
  label: string;
  createdAt: string;
  snapshot: Omit<CourseProject, 'frozenVersions'>;
}

export interface CourseProject {
  id: string;
  title: string;
  teacher: string;
  audience: string;
  status: CourseStatus;
  selectedModuleId: string;
  selectedStepId: string;
  modules: CourseModule[];
  frozenVersions: FrozenVersion[];
  lastSavedAt: string;
  revision: number;
  shootTasks: ShootTask[];
  materials: DemoMaterial[];
  suspendedReturns: SuspendedReturn[];
  nextTaskSeq: number;
}

export interface ValidationCheck {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  stepId?: string;
  moduleId?: string;
}

export interface IngestOutcome {
  applied: Array<{ taskNo: string; stepId: string; materialId: string }>;
  suspended: SuspendedReturn[];
}

export const STORAGE_KEY = 'sologsb-1012-sign-course-project-v2';
export const LEGACY_STORAGE_KEYS = ['sologsb-1012-sign-course-project-v1'];

export function formatTaskNo(seq: number): string {
  return `ST-${String(Math.max(1, seq)).padStart(4, '0')}`;
}

export function createShootTask(step: LessonStep, moduleId: string, seq: number): ShootTask {
  return {
    id: `task-${seq.toString(36)}-${Date.now().toString(36)}`,
    taskNo: formatTaskNo(seq),
    stepId: step.id,
    moduleId,
    clipName: step.demoTitle,
    status: '待拍摄',
    materialId: '',
    createdAt: new Date().toISOString(),
  };
}

/** 字幕安全区判定：画面中央字幕压中央手形或俯拍手部即不达标 */
export function captionSafeAreaOk(step: Pick<LessonStep, 'captionPosition' | 'gestureZone' | 'camera'>): boolean {
  return !(step.captionPosition === '画面中央' && (step.gestureZone === '中央' || step.camera === '俯拍手部'));
}

/**
 * 拍摄组按任务编号批量回传素材与机位。
 * 对不上的条目只挂起这几条，对上的照常入库；
 * 回传只回写素材与机位，压不到教师填的字幕、替代文本与练习。
 */
export function ingestReturnRows(project: CourseProject, rows: ReturnRow[], batchId: string): { project: CourseProject; outcome: IngestOutcome } {
  const next = cloneProject(project);
  const outcome: IngestOutcome = { applied: [], suspended: [] };
  rows.forEach((row, index) => {
    const taskNo = row.taskNo.trim();
    const suspend = (reason: string): void => {
      outcome.suspended.push({ ...row, taskNo, reason, batchId });
    };
    if (!taskNo) return suspend('任务编号为空，无法匹配拍摄任务。');
    const task = next.shootTasks.find((item) => item.taskNo === taskNo);
    if (!task) return suspend(`找不到拍摄任务 ${taskNo}。`);
    const module = next.modules.find((item) => item.id === task.moduleId);
    const step = module?.steps.find((item) => item.id === task.stepId);
    if (!module || !step) return suspend(`任务 ${taskNo} 关联的步骤已删除。`);
    if (!row.name.trim()) return suspend('素材名称缺失。');
    if (!row.camera) return suspend('机位信息缺失。');

    const material: DemoMaterial = {
      id: `mat-${Date.now().toString(36)}-${index}`,
      taskNo,
      name: row.name.trim(),
      url: row.url.trim(),
      camera: row.camera,
      status: '可用',
      returnedAt: new Date().toISOString(),
    };
    next.materials = [material, ...next.materials];
    task.status = '已回传';
    task.materialId = material.id;
    // 只回写素材地址与机位；字幕、替代文本、练习等教师字段保持不动
    step.materialId = material.id;
    step.demoUrl = material.url;
    step.camera = material.camera;
    // 按新素材重判字幕安全区
    step.materialReview = captionSafeAreaOk(step) ? '已确认' : '待确认';
    outcome.applied.push({ taskNo, stepId: step.id, materialId: material.id });
  });
  return { project: next, outcome };
}

/**
 * 素材被标成停用或重拍后，引用它的步骤按新素材重判字幕安全区，
 * 不达标的退回待确认，由教师换素材或改字幕位置。
 */
export function applyMaterialStatus(project: CourseProject, materialId: string, status: MaterialStatus): { project: CourseProject; pendingStepIds: string[] } {
  const next = cloneProject(project);
  const material = next.materials.find((item) => item.id === materialId);
  const pendingStepIds: string[] = [];
  if (!material) return { project: next, pendingStepIds };
  material.status = status;
  if (status === '重拍') {
    const task = next.shootTasks.find((item) => item.taskNo === material.taskNo);
    if (task) task.status = '待拍摄';
  }
  next.modules.forEach((module) => {
    module.steps.forEach((step) => {
      if (step.materialId !== materialId) return;
      step.materialReview = captionSafeAreaOk(step) ? '已确认' : '待确认';
      if (step.materialReview === '待确认') pendingStepIds.push(step.id);
    });
  });
  return { project: next, pendingStepIds };
}

/**
 * 旧数据没有拍摄任务编号：升级时先按现有示范片段名称认领或补开任务，
 * 再按片段名称回填素材与机位。
 */
export function migrateProject(project: CourseProject): CourseProject {
  project.shootTasks = Array.isArray(project.shootTasks) ? project.shootTasks : [];
  project.materials = Array.isArray(project.materials) ? project.materials : [];
  project.suspendedReturns = Array.isArray(project.suspendedReturns) ? project.suspendedReturns : [];
  let seq = typeof project.nextTaskSeq === 'number' && project.nextTaskSeq > 0 ? project.nextTaskSeq : 1;
  project.shootTasks.forEach((task) => {
    const match = /^ST-(\d+)$/.exec(task.taskNo ?? '');
    if (match) seq = Math.max(seq, Number(match[1]) + 1);
  });

  project.modules.forEach((module) => {
    module.steps.forEach((step) => {
      step.materialId = step.materialId ?? '';
      step.materialReview = step.materialReview ?? '已确认';
      if (step.shootTaskNo) return;
      const claimed = new Set(project.modules.flatMap((item) => item.steps.map((s) => s.shootTaskNo).filter(Boolean)));
      const existing = project.shootTasks.find((task) => task.clipName === step.demoTitle && !claimed.has(task.taskNo));
      if (existing) {
        existing.stepId = step.id;
        existing.moduleId = module.id;
        step.shootTaskNo = existing.taskNo;
      } else {
        const task = createShootTask(step, module.id, seq++);
        project.shootTasks.push(task);
        step.shootTaskNo = task.taskNo;
      }
    });
  });

  project.modules.forEach((module) => {
    module.steps.forEach((step) => {
      if (step.materialId) return;
      const material = project.materials.find((item) => item.name === step.demoTitle && item.status === '可用');
      if (!material) return;
      step.materialId = material.id;
      step.demoUrl = step.demoUrl || material.url;
      step.camera = material.camera;
      step.materialReview = captionSafeAreaOk(step) ? '已确认' : '待确认';
      const task = project.shootTasks.find((item) => item.taskNo === step.shootTaskNo);
      if (task && !task.materialId) {
        task.materialId = material.id;
        task.status = '已回传';
      }
    });
  });

  project.nextTaskSeq = seq;
  return project;
}

export function createDemoProject(): CourseProject {
  const modules: CourseModule[] = [
    {
      id: 'module-1',
      title: '模块一 · 日常问候',
      summary: '建立手形、视线和面部表情之间的配合，完成三个基础问候。',
      color: '#15827a',
      steps: [
        {
          id: 'step-1-1',
          title: '观察“你好”的完整动作',
          kind: '示范',
          duration: 35,
          demoTitle: '你好 · 正面慢速示范',
          demoUrl: '',
          handshape: '右手掌张开，拇指向上，自额头向外送出',
          gestureZone: '右侧',
          caption: '你好：手掌从额前向前送出，同时保持微笑。',
          captionPosition: '下方安全区',
          camera: '正面',
          commonMistakes: ['手掌过于僵硬', '没有视线交流'],
          exercise: '跟随示范完成两次，每次保持两秒。',
          exerciseFeedback: '镜面检查手掌高度是否与眉线一致。',
          altText: '教师面向镜头，用右手掌从额头向前送出，并点头微笑。',
          prerequisiteId: '',
          difficulty: '入门',
          cuePoints: [4, 16, 28],
          shootTaskNo: '',
          materialId: '',
          materialReview: '已确认',
        },
        {
          id: 'step-1-2',
          title: '拆解“你好”的手形',
          kind: '讲解',
          duration: 50,
          demoTitle: '你好 · 手部近景',
          demoUrl: '',
          handshape: '四指并拢，拇指张开；掌心朝左前侧',
          gestureZone: '中央',
          caption: '注意四指并拢，动作沿身体中轴向前。',
          captionPosition: '画面中央',
          camera: '俯拍手部',
          commonMistakes: ['拇指贴住掌心', '动作方向偏向一侧'],
          exercise: '固定肩部，只移动前臂完成五次。',
          exerciseFeedback: '如果动作跑偏，先在镜前标记起点和终点。',
          altText: '手部近景展示四指并拢、拇指张开的起始手形。',
          prerequisiteId: 'step-1-1',
          difficulty: '入门',
          cuePoints: [6, 24, 42],
          shootTaskNo: '',
          materialId: '',
          materialReview: '已确认',
        },
        {
          id: 'step-1-3',
          title: '双人问候练习',
          kind: '练习',
          duration: 75,
          demoTitle: '你好 · 双人轮流练习',
          demoUrl: '',
          handshape: '保持标准手形，配合点头与视线交换',
          gestureZone: '中央',
          caption: '轮流问候，每次动作结束后停一拍，再交换角色。',
          captionPosition: '上移 15%',
          camera: '全身远景',
          commonMistakes: ['动作过早结束', '两人视线没有相遇'],
          exercise: '两人一组轮流完成问候，交换三次。',
          exerciseFeedback: '同伴负责确认视线和动作停顿。',
          altText: '两名学习者相对站立，交替做出问候动作并看向对方。',
          prerequisiteId: 'step-1-2',
          difficulty: '进阶',
          cuePoints: [10, 34, 57],
          shootTaskNo: '',
          materialId: '',
          materialReview: '已确认',
        },
      ],
    },
    {
      id: 'module-2',
      title: '模块二 · 数量表达',
      summary: '用数字、空间位置和顺序词完成价格询问。',
      color: '#8a3ffc',
      steps: [
        {
          id: 'step-2-1',
          title: '数字一到五的稳定手形',
          kind: '讲解',
          duration: 60,
          demoTitle: '数字 1—5 · 镜面视图',
          demoUrl: '',
          handshape: '食指到五指依次展开，手心朝前',
          gestureZone: '中央',
          caption: '数字一到五：从食指开始依次增加，不移动手腕。',
          captionPosition: '下方安全区',
          camera: '正面',
          commonMistakes: ['拇指遮挡手指数', '手腕左右摆动'],
          exercise: '按随机口令连续展示 1—5。',
          exerciseFeedback: '每个数字保持一秒，同伴随机报数。',
          altText: '教师手心朝前，依次伸出食指到五指，展示数字一到五。',
          prerequisiteId: '',
          difficulty: '入门',
          cuePoints: [8, 26, 44],
          shootTaskNo: '',
          materialId: '',
          materialReview: '已确认',
        },
        {
          id: 'step-2-2',
          title: '组合成“多少钱”',
          kind: '示范',
          duration: 45,
          demoTitle: '多少钱 · 双手组合动作',
          demoUrl: '',
          handshape: '双手在胸前交替翻转，随后食指向前点出',
          gestureZone: '中央',
          caption: '先做“钱”的交替手形，再用食指向前询问。',
          captionPosition: '角标提示',
          camera: '右侧 45°',
          commonMistakes: ['两手动作不同步', '疑问表情缺失'],
          exercise: '配合疑问表情完成三次询问。',
          exerciseFeedback: '录下动作，检查双手是否在胸前同一高度。',
          altText: '教师双手机械交替翻转后，食指朝前点出并抬眉疑问。',
          prerequisiteId: 'step-2-1',
          difficulty: '进阶',
          cuePoints: [5, 22, 37],
          shootTaskNo: '',
          materialId: '',
          materialReview: '已确认',
        },
      ],
    },
  ];

  // 教师每加一个示范步骤就开一条拍摄任务
  const shootTasks: ShootTask[] = [];
  const materials: DemoMaterial[] = [];
  let seq = 1;
  modules.forEach((module) => {
    module.steps.forEach((step) => {
      const task = createShootTask(step, module.id, seq++);
      shootTasks.push(task);
      step.shootTaskNo = task.taskNo;
    });
  });

  // 拍摄组已回传的示范素材
  const seedMaterial = (step: LessonStep, camera: CameraAngle, url: string): void => {
    const task = shootTasks.find((item) => item.taskNo === step.shootTaskNo);
    if (!task) return;
    const material: DemoMaterial = {
      id: `mat-${task.taskNo.toLowerCase()}`,
      taskNo: task.taskNo,
      name: step.demoTitle,
      url,
      camera,
      status: '可用',
      returnedAt: new Date().toISOString(),
    };
    materials.push(material);
    task.status = '已回传';
    task.materialId = material.id;
    step.materialId = material.id;
    step.demoUrl = url;
    step.camera = camera;
    step.materialReview = captionSafeAreaOk(step) ? '已确认' : '待确认';
  };
  seedMaterial(modules[0].steps[0], '正面', 'assets/hello-front.mp4');
  seedMaterial(modules[1].steps[0], '正面', 'assets/numbers-mirror.mp4');

  return {
    id: 'sign-course-project',
    title: '零基础手语 · 问候与数量',
    teacher: '陈老师 / 特殊教育中心',
    audience: '初次接触手语的初中学习者',
    status: 'draft',
    selectedModuleId: 'module-1',
    selectedStepId: 'step-1-2',
    modules,
    frozenVersions: [],
    lastSavedAt: new Date().toISOString(),
    revision: 1,
    shootTasks,
    materials,
    suspendedReturns: [],
    nextTaskSeq: seq,
  };
}

export function selectedModule(project: CourseProject): CourseModule {
  return project.modules.find((module) => module.id === project.selectedModuleId) ?? project.modules[0];
}

export function selectedStep(project: CourseProject): LessonStep | undefined {
  const module = selectedModule(project);
  return module?.steps.find((step) => step.id === project.selectedStepId) ?? module?.steps[0];
}

export function validateProject(project: CourseProject): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const materials = project.materials ?? [];
  if (!project.title.trim()) checks.push({ id: 'title', severity: 'error', title: '课程标题缺失', detail: '发布前需要为课程填写清晰标题。' });
  if (project.modules.length === 0) checks.push({ id: 'modules', severity: 'error', title: '没有课程模块', detail: '至少需要创建一个包含学习步骤的模块。' });

  project.modules.forEach((module) => {
    if (!module.steps.length) {
      checks.push({ id: `empty-${module.id}`, severity: 'error', title: `${module.title} 没有学习步骤`, detail: '空模块无法进入复核。', moduleId: module.id });
    }
    module.steps.forEach((step, index) => {
      if (!step.altText.trim()) {
        checks.push({ id: `alt-${step.id}`, severity: 'error', title: `${step.title} 缺少替代文本`, detail: '示范片段需要描述手形、移动和面部表情。', stepId: step.id, moduleId: module.id });
      }
      if (!step.caption.trim()) {
        checks.push({ id: `caption-${step.id}`, severity: 'warning', title: `${step.title} 缺少字幕`, detail: '听障学习者在静音预览时无法获得说明。', stepId: step.id, moduleId: module.id });
      }
      if (!captionSafeAreaOk(step)) {
        checks.push({ id: `overlap-${step.id}`, severity: 'error', title: `${step.title} 字幕可能遮挡动作`, detail: `字幕位于${step.captionPosition}，而主要手形位于${step.gestureZone}。`, stepId: step.id, moduleId: module.id });
      }
      if (step.materialReview === '待确认') {
        checks.push({ id: `review-${step.id}`, severity: 'error', title: `${step.title} 的字幕安全区待确认`, detail: '素材停用或重拍后按新素材重判未达标，请换素材或调整字幕位置。', stepId: step.id, moduleId: module.id });
      }
      const material = materials.find((item) => item.id === step.materialId);
      if (material && material.status !== '可用') {
        checks.push({ id: `material-${step.id}`, severity: 'warning', title: `${step.title} 引用的素材已${material.status}`, detail: `素材「${material.name}」当前为${material.status}状态，发布前请换素材或等待重新回传。`, stepId: step.id, moduleId: module.id });
      }
      if (step.duration < 20) {
        checks.push({ id: `duration-${step.id}`, severity: 'warning', title: `${step.title} 时长过短`, detail: '示范与练习不足 20 秒，学习者来不及观察和跟做。', stepId: step.id, moduleId: module.id });
      }
      if (step.prerequisiteId) {
        const prerequisiteIndex = module.steps.findIndex((candidate) => candidate.id === step.prerequisiteId);
        if (prerequisiteIndex < 0) {
          checks.push({ id: `missing-pre-${step.id}`, severity: 'error', title: `${step.title} 的前置步骤不存在`, detail: '请重新选择前置条件或移除依赖。', stepId: step.id, moduleId: module.id });
        } else if (prerequisiteIndex >= index) {
          checks.push({ id: `jump-${step.id}`, severity: 'error', title: `${step.title} 出现步骤跳级`, detail: '前置步骤位于当前步骤之后，学习顺序无法成立。', stepId: step.id, moduleId: module.id });
        }
      }
      if (step.kind === '练习' && (!step.exercise.trim() || !step.exerciseFeedback.trim())) {
        checks.push({ id: `practice-${step.id}`, severity: 'warning', title: `${step.title} 的练习反馈不完整`, detail: '练习任务需要明确完成动作和即时反馈方式。', stepId: step.id, moduleId: module.id });
      }
      if (step.commonMistakes.filter(Boolean).length === 0) {
        checks.push({ id: `mistakes-${step.id}`, severity: 'info', title: `${step.title} 尚未记录常见错误`, detail: '补充常见错误有助于教师现场提示。', stepId: step.id, moduleId: module.id });
      }
    });
  });

  return checks;
}

export function cloneProject(project: CourseProject): CourseProject {
  return structuredClone(project);
}
