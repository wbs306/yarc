export type LatexCompletionKind = 'command' | 'environment' | 'package' | 'reference' | 'citation'

export interface LatexCompletionItem {
  label: string
  detail: string
  kind: LatexCompletionKind
  insert: string
  cursorOffset?: number
}

const command = (label: string, detail: string, insert = `${label}{}`, cursorOffset = label.length + 1): LatexCompletionItem => ({
  label,
  detail,
  kind: 'command',
  insert,
  cursorOffset,
})

export const LATEX_COMMANDS: LatexCompletionItem[] = [
  command('\\documentclass', '文档类型', '\\documentclass{}'),
  command('\\usepackage', '加载宏包', '\\usepackage{}'),
  command('\\begin', '开始环境', '\\begin{}'),
  command('\\end', '结束环境', '\\end{}'),
  command('\\title', '文档标题'),
  command('\\author', '作者'),
  command('\\date', '日期'),
  command('\\section', '一级标题'),
  command('\\subsection', '二级标题'),
  command('\\subsubsection', '三级标题'),
  command('\\paragraph', '段落标题'),
  command('\\chapter', '章节标题'),
  command('\\textbf', '粗体文本'),
  command('\\textit', '斜体文本'),
  command('\\emph', '强调文本'),
  command('\\underline', '下划线文本'),
  command('\\texttt', '等宽文本'),
  command('\\text', '数学模式中的文本'),
  command('\\footnote', '脚注'),
  command('\\label', '设置引用标签'),
  command('\\ref', '交叉引用'),
  command('\\pageref', '页码引用'),
  command('\\cite', '文献引用'),
  command('\\parencite', '括号文献引用'),
  command('\\textcite', '文本式文献引用'),
  command('\\bibliography', 'BibTeX 文献库'),
  command('\\addbibresource', 'BibLaTeX 文献库'),
  command('\\printbibliography', '输出参考文献', '\\printbibliography ', 17),
  command('\\input', '插入源文件'),
  command('\\include', '插入章节文件'),
  command('\\includegraphics', '插入图片', '\\includegraphics{}'),
  command('\\url', 'URL'),
  command('\\href', '超链接', '\\href{}{}', 6),
  command('\\frac', '分数', '\\frac{}{}', 6),
  command('\\dfrac', '展示分数', '\\dfrac{}{}', 7),
  command('\\tfrac', '行内分数', '\\tfrac{}{}', 7),
  command('\\sqrt', '平方根'),
  command('\\sum', '求和符号', '\\sum_{i=1}^{n} ', 14),
  command('\\prod', '连乘符号', '\\prod_{i=1}^{n} ', 15),
  command('\\lim', '极限', '\\lim_{x\\to} ', 12),
  command('\\left', '自动调整左定界符', '\\left(  \\right)', 7),
  command('\\right', '自动调整右定界符', '\\right'),
  command('\\maketitle', '生成标题', '\\maketitle ', 11),
  command('\\tableofcontents', '生成目录', '\\tableofcontents ', 17),
  command('\\item', '列表项', '\\item ', 6),
  command('\\newcommand', '定义新命令', '\\newcommand{\\name}[1]{}', 13),
]

export const LATEX_ENVIRONMENTS: LatexCompletionItem[] = [
  'document',
  'abstract',
  'itemize',
  'enumerate',
  'description',
  'figure',
  'table',
  'tabular',
  'tabularx',
  'equation',
  'equation*',
  'align',
  'align*',
  'alignat',
  'gather',
  'gather*',
  'multline',
  'theorem',
  'lemma',
  'proof',
  'quote',
  'quotation',
  'verbatim',
  'center',
  'flushleft',
  'flushright',
  'minipage',
  'frame',
].map((label) => ({
  label,
  detail: '环境',
  kind: 'environment' as const,
  insert: `${label}}\n  \n\\end{${label}}`,
  cursorOffset: label.length + 4,
}))

const packageNames = [
  ['amsmath', '数学公式'],
  ['amssymb', '数学符号'],
  ['mathtools', '扩展数学公式'],
  ['graphicx', '图片'],
  ['booktabs', '三线表'],
  ['array', '表格扩展'],
  ['tabularx', '自适应表格'],
  ['multirow', '跨行表格'],
  ['xcolor', '颜色'],
  ['geometry', '页面布局'],
  ['float', '浮动体位置'],
  ['caption', '标题格式'],
  ['subcaption', '子图/子表'],
  ['hyperref', '超链接'],
  ['cleveref', '智能交叉引用'],
  ['url', 'URL'],
  ['xurl', '可断行 URL'],
  ['biblatex', '现代文献引用'],
  ['natbib', '文献引用'],
  ['ctex', '中文排版'],
  ['fontspec', '字体设置'],
  ['xeCJK', '中日韩字体'],
  ['listings', '代码列表'],
  ['algorithm', '算法浮动体'],
  ['algpseudocode', '算法伪代码'],
  ['tikz', '绘图'],
  ['pgfplots', '数据绘图'],
  ['siunitx', '科学计量'],
]

export const LATEX_PACKAGES: LatexCompletionItem[] = packageNames.map(([label, detail]) => ({
  label,
  detail,
  kind: 'package' as const,
  insert: label,
}))

export const filterLatexCompletionItems = (items: LatexCompletionItem[], query: string) => {
  const normalized = query.toLowerCase()
  if (!normalized) return items
  return items.filter((item) => item.label.toLowerCase().includes(normalized))
}
