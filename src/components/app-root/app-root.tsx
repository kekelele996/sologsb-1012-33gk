import { Component, Host, State, h, Listen } from '@stencil/core';
import {
  applyMaterialStatus,
  captionSafeAreaOk,
  cloneProject,
  createDemoProject,
  createShootTask,
  formatTaskNo,
  ingestReturnRows,
  LEGACY_STORAGE_KEYS,
  migrateProject,
  selectedModule,
  selectedStep,
  STORAGE_KEY,
  validateProject,
  type CameraAngle,
  type CaptionPosition,
  type CourseModule,
  type CourseProject,
  type Difficulty,
  type GestureZone,
  type IngestOutcome,
  type LessonStep,
  type MaterialStatus,
  type ReturnRow,
  type ValidationCheck,
} from '../../models';

type PreviewSize = 'phone' | 'tablet';
type Workspace = 'teacher' | 'studio';

const emptyReturnRow = (): ReturnRow => ({
  key: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  taskNo: '',
  name: '',
  url: '',
  camera: '',
});

@Component({
  tag: 'app-root',
  styleUrl: 'app-root.css',
  scoped: true,
})
export class AppRoot {
  @State() project: CourseProject = createDemoProject();
  @State() previewSize: PreviewSize = 'phone';
  @State() activePanel: 'editor' | 'checks' = 'editor';
  @State() workspace: Workspace = 'teacher';
  @State() returnRows: ReturnRow[] = [emptyReturnRow()];
  @State() playing = false;
  @State() playProgress = 0;
  @State() offline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
  @State() toast?: { color: string; message: string };
  private past: CourseProject[] = [];
  private future: CourseProject[] = [];
  private playTimer?: number;

  componentWillLoad(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) ?? LEGACY_STORAGE_KEYS.map((key) => localStorage.getItem(key)).find((value) => value !== null);
      if (saved) {
        // 旧数据没有拍摄任务编号，升级时按现有示范片段名称回填
        this.project = migrateProject(JSON.parse(saved) as CourseProject);
        this.persist();
      }
    } catch {
      this.project = createDemoProject();
    }
  }

  disconnectedCallback(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
  }

  @Listen('online', { target: 'window' })
  handleOnline(): void {
    this.offline = false;
    this.showToast('success', '网络已恢复，本地草稿无需合并即可继续编辑。');
  }

  @Listen('offline', { target: 'window' })
  handleOffline(): void {
    this.offline = true;
    this.showToast('warning', '当前处于离线状态，修改会继续保存在本机。');
  }

  @Listen('keydown', { target: 'window' })
  handleKeyboard(event: KeyboardEvent): void {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.saveDraft(true);
      return;
    }
    if (!editing && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.moveStep(event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  private get currentModule(): CourseModule {
    return selectedModule(this.project);
  }

  private get currentStep(): LessonStep | undefined {
    return selectedStep(this.project);
  }

  private get checks(): ValidationCheck[] {
    return validateProject(this.project);
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.project));
  }

  private commit(update: (draft: CourseProject) => CourseProject, toast?: string): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '当前版本已冻结，请先创建修订版。');
      return;
    }
    const before = cloneProject(this.project);
    const next = update(cloneProject(this.project));
    next.revision = before.revision + 1;
    next.lastSavedAt = new Date().toISOString();
    this.past = [...this.past, before].slice(-80);
    this.future = [];
    this.project = next;
    this.persist();
    if (toast) this.showToast('success', toast);
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.showToast('medium', '没有可撤销的修改。');
    this.future = [cloneProject(this.project), ...this.future].slice(0, 80);
    this.project = previous;
    this.persist();
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneProject(this.project)].slice(-80);
    this.project = next;
    this.persist();
  }

  private showToast(color: string, message: string): void {
    this.toast = { color, message };
    window.setTimeout(() => {
      if (this.toast?.message === message) this.toast = undefined;
    }, 3_200);
  }

  private selectModule(moduleId: string): void {
    const module = this.project.modules.find((item) => item.id === moduleId);
    this.project = { ...this.project, selectedModuleId: moduleId, selectedStepId: module?.steps[0]?.id ?? '' };
    this.persist();
  }

  private selectStep(stepId: string): void {
    this.project = { ...this.project, selectedStepId: stepId };
    this.persist();
  }

  private updateStep(patch: Partial<LessonStep>, toast?: string): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.map((step) => {
          if (step.id !== stepId) return step;
          const merged = { ...step, ...patch };
          // 教师换素材或改字幕位置后，按现状重判字幕安全区
          if (merged.materialId || merged.materialReview === '待确认') {
            merged.materialReview = captionSafeAreaOk(merged) ? '已确认' : '待确认';
          }
          return merged;
        }),
      } : module),
    }), toast);
  }

  private updateCurrentModule(patch: Partial<CourseModule>): void {
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? { ...module, ...patch } : module),
    }));
  }

  private addModule(): void {
    const index = this.project.modules.length + 1;
    const module: CourseModule = {
      id: `module-${Date.now().toString(36)}`,
      title: `模块 ${index} · 未命名`,
      summary: '说明该模块的学习目标与适用场景。',
      color: ['#15827a', '#8a3ffc', '#b34331', '#376ea8'][index % 4],
      steps: [],
    };
    this.commit((draft) => ({ ...draft, modules: [...draft.modules, module], selectedModuleId: module.id, selectedStepId: '' }), '已创建课程模块。');
  }

  private addStep(kind: LessonStep['kind'] = '示范'): void {
    const module = this.currentModule;
    if (!module) return this.addModule();
    const prior = module.steps.at(-1);
    const taskNo = formatTaskNo(this.project.nextTaskSeq);
    const step: LessonStep = {
      id: `step-${Date.now().toString(36)}`,
      title: `新${kind}步骤 ${module.steps.length + 1}`,
      kind,
      duration: 45,
      demoTitle: '等待上传或录制示范片段',
      demoUrl: '',
      handshape: '描述起始手形、掌心方向和运动路径。',
      gestureZone: '中央',
      caption: '填写送给学习者的字幕说明。',
      captionPosition: '下方安全区',
      camera: '正面',
      commonMistakes: [],
      exercise: kind === '练习' ? '填写练习任务。' : '',
      exerciseFeedback: kind === '练习' ? '填写反馈方式。' : '',
      altText: '',
      prerequisiteId: prior?.id ?? '',
      difficulty: '入门',
      cuePoints: [8, 20, 32],
      shootTaskNo: taskNo,
      materialId: '',
      materialReview: '已确认',
    };
    // 教师每加一个示范步骤就开一条拍摄任务
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((item) => item.id === module.id ? { ...item, steps: [...item.steps, step] } : item),
      shootTasks: [...draft.shootTasks, createShootTask(step, module.id, draft.nextTaskSeq)],
      nextTaskSeq: draft.nextTaskSeq + 1,
      selectedStepId: step.id,
    }), `已新增学习步骤，并开出拍摄任务 ${taskNo}。`);
  }

  private duplicateStep(): void {
    const step = this.currentStep;
    if (!step) return;
    const taskNo = formatTaskNo(this.project.nextTaskSeq);
    const duplicate: LessonStep = { ...structuredClone(step), id: `step-${Date.now().toString(36)}`, title: `${step.title}（副本）`, shootTaskNo: taskNo };
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((item) => item.id === step.id);
        return { ...module, steps: [...module.steps.slice(0, index + 1), duplicate, ...module.steps.slice(index + 1)] };
      }),
      shootTasks: [...draft.shootTasks, createShootTask(duplicate, draft.selectedModuleId, draft.nextTaskSeq)],
      nextTaskSeq: draft.nextTaskSeq + 1,
    }), `已复制当前步骤，并开出拍摄任务 ${taskNo}。`);
  }

  private deleteStep(stepId: string): void {
    if (this.currentModule.steps.length <= 1) {
      this.showToast('warning', '模块至少保留一个学习步骤。');
      return;
    }
    const removedTaskNo = this.currentModule.steps.find((step) => step.id === stepId)?.shootTaskNo ?? '';
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.filter((step) => step.id !== stepId),
      } : module),
      shootTasks: draft.shootTasks.filter((task) => task.stepId !== stepId),
      suspendedReturns: draft.suspendedReturns.filter((row) => row.taskNo !== removedTaskNo),
      selectedStepId: this.currentModule.steps.find((step) => step.id !== stepId)?.id ?? '',
    }), '已删除学习步骤及其拍摄任务。');
  }

  private moveStep(direction: number): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((step) => step.id === stepId);
        const nextIndex = Math.max(0, Math.min(module.steps.length - 1, index + direction));
        if (index === nextIndex) return module;
        const steps = [...module.steps];
        const [item] = steps.splice(index, 1);
        steps.splice(nextIndex, 0, item);
        return { ...module, steps };
      }),
    }), '已调整步骤顺序。');
  }

  // —— 拍摄组工作台：按任务编号回传素材，不替教师改步骤 ——

  private addReturnRow(): void {
    this.returnRows = [...this.returnRows, emptyReturnRow()];
  }

  private updateReturnRow(key: string, patch: Partial<ReturnRow>): void {
    this.returnRows = this.returnRows.map((row) => row.key === key ? { ...row, ...patch } : row);
  }

  private removeReturnRow(key: string): void {
    this.returnRows = this.returnRows.filter((row) => row.key !== key);
  }

  private prefillPendingTasks(): void {
    const pending = this.project.shootTasks.filter((task) => task.status === '待拍摄');
    if (!pending.length) {
      this.showToast('medium', '当前没有待拍摄的拍摄任务。');
      return;
    }
    this.returnRows = pending.map((task) => ({ key: `row-${task.taskNo}`, taskNo: task.taskNo, name: task.clipName, url: '', camera: '' as const }));
  }

  private submitReturns(): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '当前版本已冻结，请先创建修订版。');
      return;
    }
    const rows = this.returnRows.filter((row) => row.taskNo.trim() || row.name.trim() || row.url.trim() || row.camera);
    if (!rows.length) {
      this.showToast('medium', '请先填写要回传的素材行。');
      return;
    }
    let outcome: IngestOutcome = { applied: [], suspended: [] };
    this.commit((draft) => {
      const result = ingestReturnRows(draft, rows, `batch-${Date.now().toString(36)}`);
      outcome = result.outcome;
      // 对不上的只挂起这几条，对上的照常入库
      return { ...result.project, suspendedReturns: [...result.project.suspendedReturns, ...result.outcome.suspended] };
    });
    this.returnRows = [emptyReturnRow()];
    this.showToast(outcome.suspended.length ? 'warning' : 'success', `回传完成：${outcome.applied.length} 条已入库，${outcome.suspended.length} 条对不上已挂起。`);
  }

  private retrySuspended(): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '当前版本已冻结，请先创建修订版。');
      return;
    }
    if (!this.project.suspendedReturns.length) return;
    let outcome: IngestOutcome = { applied: [], suspended: [] };
    this.commit((draft) => {
      // 失败后只重试挂起的这几条
      const result = ingestReturnRows(draft, draft.suspendedReturns, `retry-${Date.now().toString(36)}`);
      outcome = result.outcome;
      return { ...result.project, suspendedReturns: result.outcome.suspended };
    });
    this.showToast(outcome.suspended.length ? 'warning' : 'success', `重试完成：${outcome.applied.length} 条已入库，仍有 ${outcome.suspended.length} 条挂起。`);
  }

  private updateSuspendedRow(key: string, patch: Partial<ReturnRow>): void {
    this.commit((draft) => ({
      ...draft,
      suspendedReturns: draft.suspendedReturns.map((row) => row.key === key ? { ...row, ...patch } : row),
    }));
  }

  private discardSuspended(key: string): void {
    this.commit((draft) => ({ ...draft, suspendedReturns: draft.suspendedReturns.filter((row) => row.key !== key) }), '已丢弃该条挂起的回传。');
  }

  private setMaterialStatus(materialId: string, status: MaterialStatus): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '当前版本已冻结，请先创建修订版。');
      return;
    }
    const material = this.project.materials.find((item) => item.id === materialId);
    if (!material) return;
    let pending = 0;
    this.commit((draft) => {
      const result = applyMaterialStatus(draft, materialId, status);
      pending = result.pendingStepIds.length;
      return result.project;
    });
    const suffix = pending ? `，${pending} 个引用步骤退回待确认` : '';
    this.showToast(status === '可用' ? 'success' : 'warning', `素材「${material.name}」已标为${status}${suffix}。`);
  }

  /** 教师换素材：回写素材与机位，并按新素材重判字幕安全区 */
  private swapMaterial(materialId: string): void {
    const material = this.project.materials.find((item) => item.id === materialId);
    if (!material) {
      this.updateStep({ materialId: '', demoUrl: '' }, '已取消素材关联。');
      return;
    }
    this.updateStep({ materialId: material.id, demoUrl: material.url, camera: material.camera }, `已换用素材「${material.name}」，字幕安全区已按新素材重判。`);
  }

  private saveDraft(showMessage = true): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '冻结版本不可覆盖，请先创建修订版。');
      return;
    }    this.project = { ...this.project, status: 'draft', lastSavedAt: new Date().toISOString() };
    this.persist();
    if (showMessage) this.showToast('success', '草稿已保存在浏览器本地。');
  }

  private submitForReview(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `仍有 ${blocking.length} 个阻断问题，修复后才能提交复核。`);
      return;
    }
    this.commit((draft) => ({ ...draft, status: 'review' }), '课程已提交复核。');
  }

  private returnForChanges(): void {
    this.commit((draft) => ({ ...draft, status: 'changes' }), '课程已退回修改。');
  }

  private freezeVersion(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `冻结前仍有 ${blocking.length} 个阻断问题。`);
      return;
    }
    this.commit((draft) => {
      const { frozenVersions, ...snapshot } = cloneProject(draft);
      const version = {
        id: `frozen-${Date.now().toString(36)}`,
        label: `冻结版本 v${frozenVersions.length + 1}`,
        createdAt: new Date().toISOString(),
        snapshot,
      };
      return { ...draft, status: 'frozen', frozenVersions: [version, ...frozenVersions] };
    }, '当前课程版本已冻结。');
    this.playing = false;
  }

  private reviseFrozen(): void {
    this.commit((draft) => ({ ...draft, status: 'draft' }), '已创建修订版，可继续编辑。');
  }

  private togglePlay(): void {
    if (this.playTimer) {
      window.clearInterval(this.playTimer);
      this.playTimer = undefined;
      this.playing = false;
      return;
    }
    const duration = Math.max(10, this.currentStep?.duration ?? 40);
    this.playing = true;
    this.playTimer = window.setInterval(() => {
      this.playProgress += 0.25 / duration;
      if (this.playProgress >= 1) {
        this.playProgress = 0;
        this.playing = false;
        if (this.playTimer) window.clearInterval(this.playTimer);
        this.playTimer = undefined;
      }
    }, 250);
  }

  private formatDate(value: string): string {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  private renderStatusBadge() {
    if (this.project.status === 'review') return <ion-badge color="warning">待复核</ion-badge>;
    if (this.project.status === 'changes') return <ion-badge color="danger">已退回</ion-badge>;
    if (this.project.status === 'frozen') return <ion-badge color="success">已冻结</ion-badge>;
    return <ion-badge color="medium">草稿</ion-badge>;
  }

  private renderStepListItem(step: LessonStep, index: number) {
    const active = step.id === this.currentStep?.id;
    const issueCount = this.checks.filter((check) => check.stepId === step.id && check.severity !== 'info').length;
    return (
      <button class={`step-list-item ${active ? 'active' : ''}`} onClick={() => this.selectStep(step.id)}>
        <span class="step-index">{String(index + 1).padStart(2, '0')}</span>
        <span class="step-copy">
          <strong>{step.title}</strong>
          <small>{step.kind} · {step.duration}s · {step.difficulty}</small>
        </span>
        {issueCount > 0 && <span class="step-issue-count">{issueCount}</span>}
      </button>
    );
  }

  private renderStepEditor() {
    const step = this.currentStep;
    if (!step) {
      return (
        <div class="empty-editor">
          <div class="empty-glyph">手</div>
          <h2>这个模块还没有学习步骤</h2>
          <p>添加示范、讲解或练习步骤，然后设置前置条件与难度。</p>
          <ion-button class="studio-button" onClick={() => this.addStep('示范')}>添加第一个步骤</ion-button>
        </div>
      );
    }
    const frozen = this.project.status === 'frozen';
    const module = this.currentModule;
    const linkedMaterial = this.project.materials.find((item) => item.id === step.materialId);
    const prerequisites = module.steps.filter((candidate, index) => candidate.id !== step.id && index < module.steps.findIndex((item) => item.id === step.id));
    return (
      <div class="step-editor">
        <div class="editor-title-row">
          <div>
            <span class="eyebrow">学习步骤 {module.steps.findIndex((item) => item.id === step.id) + 1}</span>
            <h1>{step.title}</h1>
            <p>最后修改 {this.formatDate(this.project.lastSavedAt)} · 修订号 {this.project.revision}</p>
          </div>
          <div class="title-actions">
            <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(-1)} title="Alt + ↑">上移</ion-button>
            <ion-button fill="clear" class="studio-button" onClick={() => this.moveStep(1)} title="Alt + ↓">下移</ion-button>
            <ion-button fill="outline" class="studio-button" onClick={() => this.duplicateStep()}>复制</ion-button>
            <ion-button fill="outline" color="danger" class="studio-button" onClick={() => this.deleteStep(step.id)}>删除</ion-button>
          </div>
        </div>

        {frozen && (
          <div class="frozen-callout">
            <div><strong>此版本已冻结</strong><span>字段已锁定，仍可预览和运行检查。</span></div>
            <ion-button size="small" class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
          </div>
        )}

        <section class="form-card">
          <div class="section-title"><span>01</span><div><h2>基础设计</h2><p>标题、类型、难度和预计时长</p></div></div>
          <div class="form-grid two">
            <ion-input disabled={frozen} label="步骤标题" labelPlacement="stacked" class="studio-input" value={step.title} onIonInput={(event) => this.updateStep({ title: event.detail.value ?? '' })} />
            <ion-select disabled={frozen} label="步骤类型" labelPlacement="stacked" class="studio-input" value={step.kind} onIonChange={(event) => this.updateStep({ kind: event.detail.value as LessonStep['kind'] })}>
              <ion-select-option value="示范">示范</ion-select-option>
              <ion-select-option value="讲解">讲解</ion-select-option>
              <ion-select-option value="练习">练习</ion-select-option>
            </ion-select>
            <ion-select disabled={frozen} label="难度标签" labelPlacement="stacked" class="studio-input" value={step.difficulty} onIonChange={(event) => this.updateStep({ difficulty: event.detail.value as Difficulty })}>
              {(['入门', '进阶', '挑战'] as Difficulty[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} type="number" min="10" max="600" label="预计时长（秒）" labelPlacement="stacked" class="studio-input" value={String(step.duration)} onIonInput={(event) => this.updateStep({ duration: Number(event.detail.value) || 0 })} />
          </div>
        </section>

        <section class="form-card">
          <div class="section-title"><span>02</span><div><h2>示范片段与镜头</h2><p>拍摄任务、素材、手形、镜头角度和动作区域</p></div></div>
          <div class="demo-row">
            <div class={`video-thumbnail zone-${step.gestureZone}`}>
              <span class="play-mark">▶</span>
              <strong>{step.kind}片段</strong>
              <small>{step.camera}</small>
            </div>
            <div class="demo-fields">
              <ion-input disabled={frozen} label="示范片段名称" labelPlacement="stacked" class="studio-input" value={step.demoTitle} onIonInput={(event) => this.updateStep({ demoTitle: event.detail.value ?? '' })} />
              <ion-input disabled={frozen} label="本地素材地址（可空）" labelPlacement="stacked" class="studio-input" value={step.demoUrl} placeholder="例如 assets/hello.mp4" onIonInput={(event) => this.updateStep({ demoUrl: event.detail.value ?? '' })} />
            </div>
          </div>
          <div class="form-grid two">
            <ion-input readonly label="拍摄任务编号" labelPlacement="stacked" class="studio-input" value={step.shootTaskNo || '未开任务'} />
            <ion-select disabled={frozen} label="关联素材（教师可换素材）" labelPlacement="stacked" class="studio-input" value={step.materialId} onIonChange={(event) => this.swapMaterial(event.detail.value as string)}>
              <ion-select-option value="">不关联素材</ion-select-option>
              {this.project.materials.filter((item) => item.status === '可用' || item.id === step.materialId).map((item) => (
                <ion-select-option value={item.id}>{item.name} · {item.camera}{item.status === '可用' ? '' : `（${item.status}）`}</ion-select-option>
              ))}
            </ion-select>
          </div>
          {linkedMaterial && linkedMaterial.status !== '可用' && (
            <div class="material-alert">素材「{linkedMaterial.name}」已被拍摄组标为{linkedMaterial.status}，请换素材或等待重新回传。</div>
          )}
          {step.materialReview === '待确认' && (
            <div class="review-callout">
              <div>
                <strong>字幕安全区待确认</strong>
                <span>素材停用或重拍后，按新素材重判未达标。请换素材，或到「字幕与无障碍」调整字幕位置。</span>
              </div>
            </div>
          )}
          <div class="form-grid two">
            <ion-select disabled={frozen} label="镜头角度" labelPlacement="stacked" class="studio-input" value={step.camera} onIonChange={(event) => this.updateStep({ camera: event.detail.value as CameraAngle })}>
              {(['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'] as CameraAngle[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-select disabled={frozen} label="主要手形区域" labelPlacement="stacked" class="studio-input" value={step.gestureZone} onIonChange={(event) => this.updateStep({ gestureZone: event.detail.value as GestureZone })}>
              {(['左侧', '中央', '右侧'] as GestureZone[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
          </div>
          <ion-textarea disabled={frozen} autoGrow label="手形说明" labelPlacement="stacked" class="studio-input" value={step.handshape} onIonInput={(event) => this.updateStep({ handshape: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>03</span><div><h2>字幕与无障碍</h2><p>检查字幕位置、动作遮挡与替代文本</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="字幕位置" labelPlacement="stacked" class="studio-input" value={step.captionPosition} onIonChange={(event) => this.updateStep({ captionPosition: event.detail.value as CaptionPosition })}>
              {(['下方安全区', '上移 15%', '角标提示', '画面中央'] as CaptionPosition[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="替代文本状态" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText ? '已填写' : '缺失'} readonly />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="步骤字幕" labelPlacement="stacked" class="studio-input" value={step.caption} onIonInput={(event) => this.updateStep({ caption: event.detail.value ?? '' })} />
          <ion-textarea disabled={frozen} autoGrow label="替代文本（必须描述动作与表情）" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText} onIonInput={(event) => this.updateStep({ altText: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>04</span><div><h2>学习依赖与练习</h2><p>前置步骤、常见错误、练习任务与反馈</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="前置条件" labelPlacement="stacked" class="studio-input" value={step.prerequisiteId} onIonChange={(event) => this.updateStep({ prerequisiteId: event.detail.value ?? '' })}>
              <ion-select-option value="">无前置条件</ion-select-option>
              {prerequisites.map((item) => <ion-select-option value={item.id}>{item.title}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="检查点（秒，用逗号分隔）" labelPlacement="stacked" class="studio-input" value={step.cuePoints.join(', ')} onIonInput={(event) => this.updateStep({ cuePoints: (event.detail.value ?? '').split(/[,，\s]+/).map(Number).filter((value) => Number.isFinite(value)) })} />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="常见错误（每行一条）" labelPlacement="stacked" class="studio-input" value={step.commonMistakes.join('\n')} onIonInput={(event) => this.updateStep({ commonMistakes: (event.detail.value ?? '').split('\n').filter(Boolean) })} />
          <div class="form-grid two">
            <ion-textarea disabled={frozen} autoGrow label="练习任务" labelPlacement="stacked" class="studio-input" value={step.exercise} onIonInput={(event) => this.updateStep({ exercise: event.detail.value ?? '' })} />
            <ion-textarea disabled={frozen} autoGrow label="练习反馈" labelPlacement="stacked" class="studio-input" value={step.exerciseFeedback} onIonInput={(event) => this.updateStep({ exerciseFeedback: event.detail.value ?? '' })} />
          </div>
        </section>
      </div>
    );
  }

  private renderReturnRowFields(row: ReturnRow, onPatch: (patch: Partial<ReturnRow>) => void, onRemove: () => void) {
    return (
      <div class="return-row">
        <ion-input label="任务编号" labelPlacement="stacked" class="studio-input" value={row.taskNo} placeholder="ST-0001" onIonInput={(event) => onPatch({ taskNo: event.detail.value ?? '' })} />
        <ion-input label="素材名称" labelPlacement="stacked" class="studio-input" value={row.name} onIonInput={(event) => onPatch({ name: event.detail.value ?? '' })} />
        <ion-input label="素材地址" labelPlacement="stacked" class="studio-input" value={row.url} placeholder="assets/clip.mp4" onIonInput={(event) => onPatch({ url: event.detail.value ?? '' })} />
        <ion-select label="机位" labelPlacement="stacked" class="studio-input" value={row.camera} onIonChange={(event) => onPatch({ camera: event.detail.value as CameraAngle })}>
          {(['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'] as CameraAngle[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
        </ion-select>
        <button class="row-remove" title="移除该行" onClick={onRemove}>×</button>
      </div>
    );
  }

  private renderStudio() {
    const stepOf = (taskNo: string) => {
      const task = this.project.shootTasks.find((item) => item.taskNo === taskNo);
      return task ? this.project.modules.find((module) => module.id === task.moduleId)?.steps.find((step) => step.id === task.stepId) : undefined;
    };
    const suspended = this.project.suspendedReturns;
    return (
      <main class="studio-workspace crew-workspace">
        <aside class="course-panel">
          <div class="panel-heading"><div><span class="eyebrow">拍摄组</span><h2>拍摄任务</h2></div><span class="task-count">{this.project.shootTasks.length}</span></div>
          <div class="module-list">
            {this.project.shootTasks.map((task) => {
              const step = stepOf(task.taskNo);
              const material = this.project.materials.find((item) => item.id === task.materialId);
              return (
                <section class="task-card" key={task.id}>
                  <div class="task-head"><strong>{task.taskNo}</strong><span class={`task-status status-${task.status}`}>{task.status}</span></div>
                  <div class="task-body">
                    <strong>{task.clipName}</strong>
                    <small>关联步骤：{step ? step.title : '步骤已删除'}</small>
                    <small>素材：{material ? `${material.name}（${material.status}）` : '未回传'}</small>
                  </div>
                </section>
              );
            })}
            {!this.project.shootTasks.length && <div class="empty-side">教师添加示范步骤后会自动开出拍摄任务。</div>}
          </div>
        </aside>

        <section class="editor-panel">
          <div class="panel-switcher"><button class="active">素材回传</button></div>
          <div class="editor-scroll">
            <div class="step-editor">
              <section class="form-card">
                <div class="section-title"><span>01</span><div><h2>按任务编号回传</h2><p>只回写素材与机位，不会覆盖教师填的字幕、替代文本与练习</p></div></div>
                {this.returnRows.map((row) => this.renderReturnRowFields(row, (patch) => this.updateReturnRow(row.key, patch), () => this.removeReturnRow(row.key)))}
                <div class="return-actions">
                  <ion-button fill="outline" class="studio-button" onClick={() => this.addReturnRow()}>＋ 添加一行</ion-button>
                  <ion-button fill="outline" class="studio-button" onClick={() => this.prefillPendingTasks()}>填入全部待拍任务</ion-button>
                  <ion-button color="primary" class="studio-button" onClick={() => this.submitReturns()}>提交回传</ion-button>
                </div>
              </section>

              <section class="form-card">
                <div class="section-title"><span>02</span><div><h2>挂起的回传（{suspended.length}）</h2><p>对不上的条目只挂起这几条；修正后重试也只处理它们</p></div></div>
                {suspended.length === 0 && <p class="muted-note">当前没有挂起的回传。</p>}
                {suspended.map((row) => (
                  <div class="suspended-row" key={row.key}>
                    <div class="suspend-reason">{row.reason}</div>
                    {this.renderReturnRowFields(row, (patch) => this.updateSuspendedRow(row.key, patch), () => this.discardSuspended(row.key))}
                  </div>
                ))}
                {suspended.length > 0 && (
                  <div class="return-actions">
                    <ion-button color="warning" class="studio-button" onClick={() => this.retrySuspended()}>只重试这 {suspended.length} 条</ion-button>
                  </div>
                )}
              </section>
            </div>
          </div>
        </section>

        <section class="preview-panel material-panel">
          <div class="preview-head"><div><span class="eyebrow">示范素材库</span><h2>素材与状态</h2></div></div>
          <div class="material-list">
            {this.project.materials.map((material) => {
              const usedBy = this.project.modules.flatMap((module) => module.steps).filter((step) => step.materialId === material.id);
              return (
                <section class="material-card" key={material.id}>
                  <div class="material-head"><strong>{material.name}</strong><span class={`material-status ms-${material.status}`}>{material.status}</span></div>
                  <small>{material.taskNo} · 机位 {material.camera} · {material.url || '无地址'}</small>
                  <small>被 {usedBy.length} 个步骤引用{usedBy.length ? `：${usedBy.map((step) => step.title).join('、')}` : ''}</small>
                  <div class="material-actions">
                    {material.status !== '可用' && <ion-button size="small" fill="outline" class="studio-button" onClick={() => this.setMaterialStatus(material.id, '可用')}>恢复可用</ion-button>}
                    {material.status !== '停用' && <ion-button size="small" fill="outline" color="danger" class="studio-button" onClick={() => this.setMaterialStatus(material.id, '停用')}>标为停用</ion-button>}
                    {material.status !== '重拍' && <ion-button size="small" fill="outline" color="warning" class="studio-button" onClick={() => this.setMaterialStatus(material.id, '重拍')}>标为重拍</ion-button>}
                  </div>
                </section>
              );
            })}
            {!this.project.materials.length && <div class="empty-side">回传后素材会进入素材库。</div>}
          </div>
        </section>
      </main>
    );
  }

  private renderPreview() {
    const step = this.currentStep;
    const progress = Math.round(this.playProgress * 100);
    return (
      <section class="preview-panel">
        <div class="preview-head">
          <div><span class="eyebrow">学习者预览</span><h2>设备与安全区检查</h2></div>
          <ion-segment value={this.previewSize} class="studio-segment" onIonChange={(event) => { this.previewSize = event.detail.value as PreviewSize; }}>
            <ion-segment-button value="phone">手机</ion-segment-button>
            <ion-segment-button value="tablet">平板</ion-segment-button>
          </ion-segment>
        </div>
        {step ? (
          <div class={`device-frame ${this.previewSize}`}>
            <div class="device-top"><span>{this.previewSize === 'phone' ? '9:16' : '4:3'}</span><span>{step.camera}</span></div>
            <div class={`preview-stage zone-${step.gestureZone} caption-${step.captionPosition.replace(/\s|%/g, '')} ${step.captionPosition === '画面中央' && step.gestureZone === '中央' ? 'overlap-warning' : ''}`}>
              <div class="stage-grid" />
              <div class="signer">
                <div class="head"><span class="face"><i /><i /></span></div>
                <div class="torso" />
                <div class="arm arm-left"><span class="hand" /></div>
                <div class="arm arm-right"><span class="hand" /></div>
              </div>
              <div class="gesture-marker" style={{ left: step.gestureZone === '左侧' ? '18%' : step.gestureZone === '右侧' ? '70%' : '43%' }} />
              <div class="caption-preview">{step.caption || '未填写字幕'}</div>
              {step.captionPosition === '角标提示' && <div class="corner-caption">{step.caption.slice(0, 18) || '角标提示'}</div>}
              <div class="safe-area"><span>字幕安全区</span></div>
            </div>
            <div class="player-controls">
              <button class="play-button" onClick={() => this.togglePlay()}>{this.playing ? 'Ⅱ' : '▶'}</button>
              <div class="player-timeline">
                <span style={{ width: `${progress}%` }} />
                {step.cuePoints.map((cue) => <i style={{ left: `${Math.min(100, (cue / Math.max(1, step.duration)) * 100)}%` }} title={`检查点 ${cue}s`} />)}
              </div>
              <span class="time-code">{String(Math.floor(this.playProgress * step.duration)).padStart(2, '0')} / {step.duration}s</span>
            </div>
            <div class="preview-meta">
              <div><strong>{step.kind}</strong><span>步骤类型</span></div>
              <div><strong>{step.difficulty}</strong><span>难度标签</span></div>
              <div><strong>{step.cuePoints.length}</strong><span>检查点</span></div>
            </div>
            <p class="preview-caption-text">{step.caption}</p>
          </div>
        ) : <div class="empty-preview">选择步骤后显示设备预览。</div>}
      </section>
    );
  }

  private renderChecks() {
    const errors = this.checks.filter((check) => check.severity === 'error');
    const warnings = this.checks.filter((check) => check.severity === 'warning');
    const info = this.checks.filter((check) => check.severity === 'info');
    return (
      <section class="checks-panel">
        <div class="checks-summary">
          <div class="check-stat danger"><strong>{errors.length}</strong><span>阻断问题</span></div>
          <div class="check-stat warning"><strong>{warnings.length}</strong><span>需注意</span></div>
          <div class="check-stat"><strong>{info.length}</strong><span>优化建议</span></div>
        </div>
        <div class="check-list">
          {this.checks.length === 0 && <div class="all-clear"><strong>✓ 未发现问题</strong><p>字幕遮挡、步骤跳级和替代文本检查均已通过。</p></div>}
          {this.checks.map((check) => (
            <button class={`check-item ${check.severity}`} onClick={() => {
              if (check.moduleId) this.selectModule(check.moduleId);
              if (check.stepId) this.selectStep(check.stepId);
              this.activePanel = 'editor';
            }}>
              <span class="check-severity">{check.severity === 'error' ? '!' : check.severity === 'warning' ? '△' : 'i'}</span>
              <span><strong>{check.title}</strong><small>{check.detail}</small></span>
              <span class="check-arrow">→</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  render() {
    const module = this.currentModule;
    const errors = this.checks.filter((check) => check.severity === 'error').length;
    return (
      <Host>
        <ion-app>
          <ion-header class="studio-header">
            <ion-toolbar>
              <ion-buttons slot="start"><div class="logo-mark">手</div><div class="app-title"><strong>SignCourse Studio</strong><span>手语课程编排工具</span></div></ion-buttons>
              <ion-buttons slot="end" class="header-actions">
                <ion-segment value={this.workspace} class="workspace-segment" onIonChange={(event) => { this.workspace = event.detail.value as Workspace; }}>
                  <ion-segment-button value="teacher">教师</ion-segment-button>
                  <ion-segment-button value="studio">拍摄组</ion-segment-button>
                </ion-segment>
                <button class={`connection-status ${this.offline ? 'offline' : ''}`} onClick={() => { this.offline = !this.offline; this.showToast(this.offline ? 'warning' : 'success', this.offline ? '已进入离线模拟，编辑继续保存在本机。' : '已恢复在线模拟，本地草稿保持同步。'); }}><span />{this.offline ? '离线编辑中（点击恢复）' : '本地自动保存（点击模拟离线）'}</button>
                <ion-button fill="clear" class="studio-button" disabled={this.past.length === 0} onClick={() => this.undo()}>撤销</ion-button>
                <ion-button fill="clear" class="studio-button" disabled={this.future.length === 0} onClick={() => this.redo()}>重做</ion-button>
                <ion-button fill="outline" class="studio-button" onClick={() => this.saveDraft()}>保存草稿</ion-button>
                {this.project.status === 'review'
                  ? <ion-button color="success" class="studio-button" onClick={() => this.freezeVersion()}>冻结版本</ion-button>
                  : this.project.status === 'changes'
                    ? <ion-button color="warning" class="studio-button" onClick={() => this.submitForReview()}>重新提交</ion-button>
                    : this.project.status === 'frozen'
                      ? <ion-button class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
                      : <ion-button color="primary" class="studio-button" onClick={() => this.submitForReview()}>提交复核</ion-button>}
              </ion-buttons>
            </ion-toolbar>
          </ion-header>

          <ion-content fullscreen>
            <div class="project-ribbon">
              <div class="project-heading">
                {this.renderStatusBadge()}
                <ion-input value={this.project.title} class="project-title-input" onIonInput={(event) => { this.project = { ...this.project, title: event.detail.value ?? '' }; this.persist(); }} />
                <span>{this.project.teacher} · {this.project.audience}</span>
              </div>
              <div class="project-metrics">
                <div><strong>{this.project.modules.length}</strong><span>模块</span></div>
                <div><strong>{this.project.modules.reduce((sum, item) => sum + item.steps.length, 0)}</strong><span>步骤</span></div>
                <div><strong>{Math.ceil(this.project.modules.reduce((sum, item) => sum + item.steps.reduce((total, lesson) => total + lesson.duration, 0), 0) / 60)}</strong><span>分钟</span></div>
                <div class={errors ? 'has-errors' : ''}><strong>{errors}</strong><span>阻断问题</span></div>
              </div>
              <div class="workflow-actions">
                {this.project.status === 'review' && <ion-button fill="clear" color="danger" class="studio-button" onClick={() => this.returnForChanges()}>退回修改</ion-button>}
                {this.project.status === 'draft' && <ion-button fill="clear" class="studio-button" onClick={() => this.addModule()}>＋ 新建模块</ion-button>}
                <ion-button fill="clear" class="studio-button" onClick={() => this.addStep('练习')}>＋ 练习步骤</ion-button>
              </div>
            </div>

            {this.workspace === 'teacher' ? (
            <main class="studio-workspace">
              <aside class="course-panel">
                <div class="panel-heading"><div><span class="eyebrow">课程结构</span><h2>模块与步骤</h2></div><button class="add-step-button" onClick={() => this.addStep('示范')}>＋</button></div>
                <div class="module-list">
                  {this.project.modules.map((item) => (
                    <section class={`module-card ${item.id === module?.id ? 'active' : ''}`} key={item.id}>
                      <button class="module-head" onClick={() => this.selectModule(item.id)}>
                        <span class="module-color" style={{ background: item.color }} />
                        <span><strong>{item.title}</strong><small>{item.steps.length} 个学习步骤</small></span>
                      </button>
                      {item.id === module?.id && <div class="step-list">{item.steps.map((lesson, index) => this.renderStepListItem(lesson, index))}</div>}
                    </section>
                  ))}
                </div>
                <div class="module-editor">
                  <ion-input disabled={this.project.status === 'frozen'} label="当前模块标题" labelPlacement="stacked" class="studio-input" value={module?.title ?? ''} onIonInput={(event) => this.updateCurrentModule({ title: event.detail.value ?? '' })} />
                  <ion-textarea disabled={this.project.status === 'frozen'} autoGrow label="模块目标" labelPlacement="stacked" class="studio-input" value={module?.summary ?? ''} onIonInput={(event) => this.updateCurrentModule({ summary: event.detail.value ?? '' })} />
                </div>
              </aside>

              <section class="editor-panel">
                <div class="panel-switcher">
                  <button class={this.activePanel === 'editor' ? 'active' : ''} onClick={() => { this.activePanel = 'editor'; }}>步骤编排</button>
                  <button class={this.activePanel === 'checks' ? 'active' : ''} onClick={() => { this.activePanel = 'checks'; }}>发布前检查 <span>{this.checks.length}</span></button>
                </div>
                <div class="editor-scroll">{this.activePanel === 'editor' ? this.renderStepEditor() : this.renderChecks()}</div>
              </section>

              {this.renderPreview()}
            </main>
            ) : this.renderStudio()}
          </ion-content>
          <ion-toast isOpen={Boolean(this.toast)} message={this.toast?.message} color={this.toast?.color} duration={3200} onDidDismiss={() => { this.toast = undefined; }} />
        </ion-app>
      </Host>
    );
  }
}
