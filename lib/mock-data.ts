export type ProjectItem = {
  id: string;
  name: string;
  caseType: string;
};

export type FileItem = {
  id: string;
  name: string;
  type: "ZIP" | "PDF" | "WORD" | "图片" | "文本" | "Excel" | "CSV" | "其他";
  rel_path?: string;
  readable?: boolean;
  unreadable_reason?: string;
  referenced: boolean;
};

export const mockProjects: ProjectItem[] = [
  { id: "p1", name: "华东数据跨境项目", caseType: "数据合规审查" },
  { id: "p2", name: "跨境营销素材投放", caseType: "广告合规审查" },
  { id: "p3", name: "供应链合作协议更新", caseType: "合同合规审查" },
];

export const mockFiles: FileItem[] = [
  { id: "f1", name: "被审查协议包.zip", type: "ZIP", referenced: true },
  { id: "f2", name: "业务流程说明.pdf", type: "PDF", referenced: false },
  { id: "f3", name: "产品页面截图_01.png", type: "图片", referenced: true },
  { id: "f4", name: "宣传海报草图.jpg", type: "图片", referenced: false },
];
