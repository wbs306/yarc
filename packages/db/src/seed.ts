import { prisma } from './index.js'

async function seed() {
  console.log('🌱 Seeding database...')

  // Clean existing data
  await prisma.task.deleteMany()
  await prisma.message.deleteMany()
  await prisma.conversation.deleteMany()
  await prisma.note.deleteMany()
  await prisma.paperChunk.deleteMany()
  await prisma.paper.deleteMany()
  await prisma.category.deleteMany()
  await prisma.setting.deleteMany()

  // ── Categories ─────────────────────────────────────────────────────────────

  const cs = await prisma.category.create({ data: { name: '深度学习', color: '#6366f1' } })
  const nlp = await prisma.category.create({ data: { name: '自然语言处理', color: '#8b5cf6' } })
  const cv = await prisma.category.create({ data: { name: '计算机视觉', color: '#06b6d4' } })
  const mec = await prisma.category.create({ data: { name: '边缘计算', color: '#22c55e' } })
  const opt = await prisma.category.create({ data: { name: '组合优化', color: '#f59e0b' } })

  // ── Papers ─────────────────────────────────────────────────────────────────

  const papers = await Promise.all([
    prisma.paper.create({
      data: {
        title: 'Attention Is All You Need',
        abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.',
        authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones'],
        year: 2017,
        doi: '10.48550/arXiv.1706.03762',
        arxivId: '1706.03762',
        categoryId: nlp.id,
        parseStatus: 'completed',
        embeddingStatus: 'completed',
        embeddingProgress: 1,
        summaryStatus: 'completed',
        summary: '提出了 Transformer 架构，完全基于自注意力机制，摒弃了循环和卷积结构。在机器翻译任务上取得了最优结果，同时大幅提升了训练效率。该架构成为后续 BERT、GPT 等模型的基础。',
        tags: ['transformer', 'attention', 'nlp'],
      },
    }),
    prisma.paper.create({
      data: {
        title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
        abstract: 'We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Representations from Transformers. BERT is designed to pre-train deep bidirectional representations.',
        authors: ['Jacob Devlin', 'Ming-Wei Chang', 'Kenton Lee', 'Kristina Toutanova'],
        year: 2019,
        doi: '10.18653/v1/N19-1423',
        categoryId: nlp.id,
        parseStatus: 'completed',
        embeddingStatus: 'completed',
        embeddingProgress: 1,
        summaryStatus: 'completed',
        summary: '提出了 BERT 模型，通过掩码语言模型和下一句预测两个预训练任务，在大规模语料上学习双向语言表示。在 11 项 NLP 任务上刷新了最优记录。',
        tags: ['bert', 'pre-training', 'nlp'],
      },
    }),
    prisma.paper.create({
      data: {
        title: 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale',
        abstract: 'While the Transformer architecture has become the de-facto standard for natural language processing tasks, its applications to computer vision remain limited. We show that a pure transformer applied directly to sequences of image patches can perform very well on image classification tasks.',
        authors: ['Alexey Dosovitskiy', 'Lucas Beyer', 'Alexander Kolesnikov'],
        year: 2021,
        doi: '10.48550/arXiv.2010.11929',
        arxivId: '2010.11929',
        categoryId: cv.id,
        parseStatus: 'completed',
        embeddingStatus: 'completed',
        embeddingProgress: 1,
        summaryStatus: 'pending',
        tags: ['vit', 'vision-transformer', 'classification'],
      },
    }),
    prisma.paper.create({
      data: {
        title: 'Deep Residual Learning for Image Recognition',
        abstract: 'Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously.',
        authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'],
        year: 2016,
        doi: '10.1109/CVPR.2016.90',
        categoryId: cv.id,
        parseStatus: 'completed',
        embeddingStatus: 'pending',
        summaryStatus: 'pending',
        tags: ['resnet', 'residual', 'deep-learning'],
      },
    }),
    prisma.paper.create({
      data: {
        title: 'Generative Adversarial Nets',
        abstract: 'We propose a new framework for estimating generative models via an adversarial process, in which we simultaneously train two models: a generative model G that captures the data distribution, and a discriminative model D that estimates the probability that a sample came from the training data.',
        authors: ['Ian J. Goodfellow', 'Jean Pouget-Abadie', 'Mehdi Mirza'],
        year: 2014,
        doi: '10.48550/arXiv.1406.2661',
        categoryId: cs.id,
        parseStatus: 'completed',
        embeddingStatus: 'pending',
        summaryStatus: 'pending',
        tags: ['gan', 'generative', 'adversarial'],
      },
    }),
    prisma.paper.create({
      data: {
        title: 'Computation Offloading and Resource Allocation for Cloud Assisted Mobile Edge Computing',
        abstract: 'Mobile edge computing (MEC) is an emerging paradigm that provides cloud computing capabilities at the edge of cellular networks. We study the joint optimization of computation offloading and resource allocation in a multi-user MEC system.',
        authors: ['Yuyi Mao', 'Jun Zhang', 'K.B. Letaief'],
        year: 2016,
        doi: '10.1109/TWC.2016.2587659',
        categoryId: mec.id,
        parseStatus: 'completed',
        embeddingStatus: 'pending',
        summaryStatus: 'pending',
        tags: ['mec', 'offloading', 'resource-allocation'],
      },
    }),
    prisma.paper.create({
      data: {
        title: 'A Survey on Multi-Access Edge Computing for Internet of Things',
        abstract: 'Multi-access edge computing (MEC) is a key enabler for meeting the stringent requirements of Internet of Things (IoT) applications. This survey provides a comprehensive overview of MEC for IoT.',
        authors: ['Peng Li', 'Song Guo', 'Jiannong Cao'],
        year: 2021,
        categoryId: mec.id,
        parseStatus: 'processing',
        embeddingStatus: 'pending',
        summaryStatus: 'pending',
        tags: ['mec', 'iot', 'survey'],
      },
    }),
    prisma.paper.create({
      data: {
        title: 'A Faster Algorithm for the Generalized Assignment Problem',
        abstract: 'The generalized assignment problem (GAP) is a well-known NP-hard combinatorial optimization problem. We present a faster approximation algorithm based on LP relaxation and rounding.',
        authors: ['David B. Shmoys', 'Éva Tardos'],
        year: 1993,
        categoryId: opt.id,
        parseStatus: 'pending',
        embeddingStatus: 'pending',
        summaryStatus: 'pending',
        tags: ['gap', 'approximation', 'optimization'],
      },
    }),
  ])

  // ── Notes ──────────────────────────────────────────────────────────────────

  await prisma.note.createMany({
    data: [
      {
        paperId: papers[0].id,
        content: '自注意力机制的核心公式：Attention(Q,K,V) = softmax(QK^T/√d_k)V。多头注意力允许模型同时关注不同位置的表示子空间。',
        pageNumber: 3,
        highlightText: 'Attention(Q,K,V) = softmax(QK^T/√d_k)V',
        kind: 'highlight',
      },
      {
        paperId: papers[0].id,
        content: 'Transformer 的位置编码使用正弦和余弦函数，因为模型本身不包含循环或卷积结构，需要额外注入位置信息。后续工作（如 RoPE、ALiBi）对此有改进。',
        pageNumber: 4,
        kind: 'note',
      },
      {
        paperId: papers[1].id,
        content: 'BERT 的两个预训练任务：MLM（随机遮盖 15% 的 token）和 NSP（判断两句话是否连续）。MLM 使得模型能学到真正的双向表示。',
        pageNumber: 2,
        highlightText: 'Masked Language Model (MLM)',
        kind: 'highlight',
      },
      {
        paperId: papers[2].id,
        content: 'ViT 将图像分割为 16×16 的 patch，每个 patch 线性映射为一个 token，然后送入标准 Transformer encoder。在大规模数据集上预训练后，效果优于 CNN。',
        pageNumber: 1,
        kind: 'note',
      },
      {
        paperId: papers[5].id,
        content: 'MEC 系统中的计算卸载决策是一个二元优化问题（本地执行 vs 卸载到边缘），联合考虑用户传输功率和边缘计算资源分配，可以用 DC（Difference of Convex）方法求解。',
        pageNumber: 5,
        kind: 'note',
      },
    ],
  })

  // ── Conversations ──────────────────────────────────────────────────────────

  const conv1 = await prisma.conversation.create({
    data: {
      title: '关于 Transformer 的讨论',
      paperId: papers[0].id,
      model: 'anthropic/claude-sonnet-4',
    },
  })

  await prisma.message.createMany({
    data: [
      {
        conversationId: conv1.id,
        role: 'user',
        content: '这篇论文的主要贡献是什么？',
        metadata: { context: { paperId: papers[0].id, pageNumber: 1, selectedText: 'Attention Is All You Need' } },
      },
      {
        conversationId: conv1.id,
        role: 'assistant',
        content: '这篇论文的核心贡献是提出了 **Transformer** 架构，主要创新点包括：\n\n1. **纯注意力机制**：完全摒弃了 RNN 和 CNN，仅使用自注意力（Self-Attention）来建模序列中的全局依赖关系\n2. **多头注意力**：允许模型在不同的表示子空间中同时关注不同位置的信息\n3. **位置编码**：通过正弦函数注入序列位置信息，弥补了没有循环结构的缺陷\n4. **并行计算**：相比 RNN 的顺序处理，Transformer 可以完全并行化，大幅提升了训练效率\n\n这项工作奠定了后续 BERT、GPT 系列、以及现代大语言模型的基础。',
        metadata: { citations: [{ pageNumber: 3, text: 'Self-Attention mechanism' }] },
      },
      {
        conversationId: conv1.id,
        role: 'user',
        content: '多头注意力相比单头有什么优势？',
      },
      {
        conversationId: conv1.id,
        role: 'assistant',
        content: '多头注意力的优势在于：\n\n- **多子空间表示**：每个头可以学习关注不同类型的关系（如语法关系、语义关系等）\n- **更丰富的特征**：不同的头可以关注不同位置的信息，单头则只能产生一种注意力分布\n- **稳定训练**：多个头的输出拼接后再投影，起到了类似集成学习的效果\n\n论文中使用了 8 个头，每个头的维度为 d_k = d_model/h = 64。',
        metadata: { citations: [{ pageNumber: 3, text: 'Multi-Head Attention' }, { pageNumber: 4, text: 'h = 8' }] },
      },
    ],
  })

  const conv2 = await prisma.conversation.create({
    data: {
      title: '边缘计算卸载策略',
      model: 'anthropic/claude-sonnet-4',
    },
  })

  await prisma.message.createMany({
    data: [
      {
        conversationId: conv2.id,
        role: 'user',
        content: 'MEC 中的计算卸载问题如何建模为优化问题？',
      },
      {
        conversationId: conv2.id,
        role: 'assistant',
        content: 'MEC 计算卸载通常建模为**混合整数非线性规划（MINLP）**问题：\n\n**决策变量**：\n- 二元变量 a_n ∈ {0,1}：表示用户 n 是否卸载\n- 连续变量 f_n：边缘服务器分配给用户 n 的计算资源\n- 连续变量 p_n：用户 n 的传输功率\n\n**目标函数**：最小化系统总时延或总能耗（或两者的加权和）\n\n**约束条件**：\n- 计算资源约束：Σf_n ≤ F_max\n- 传输功率约束：0 ≤ p_n ≤ P_max\n- 时延约束：任务完成时间 ≤ 截止时间\n\n这类问题是 NP-hard 的，常见求解方法包括：\n1. 凸松弛 + 分支定界\n2. ADMM（交替方向乘子法）\n3. 深度强化学习\n4. 启发式算法（贪心、遗传算法等）',
      },
    ],
  })

  // ── Settings ───────────────────────────────────────────────────────────────

  await prisma.setting.createMany({
    data: [
      { key: 'theme', value: { mode: 'light', primaryColor: '#6366f1' } },
      { key: 'models', value: { default: 'anthropic/claude-sonnet-4' } },
    ],
  })

  console.log('✅ Seed complete')
  console.log(`   ${papers.length} papers, 5 categories, 2 conversations, 5 notes`)
}

seed()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
