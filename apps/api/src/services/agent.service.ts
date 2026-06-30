import { prisma } from '@yarc/db'

interface AgentResponse {
  success: boolean
  message: string
  data?: any
}

export class AgentService {
  // 自动分类论文。
  async autoClassifyPaper(paperId: string): Promise<AgentResponse> {
    try {
      const paper = await prisma.paper.findUnique({
        where: { id: paperId }
      })

      if (!paper) {
        return {
          success: false,
          message: '论文不存在'
        }
      }

      const categories = await prisma.category.findMany()
      const title = paper.title.toLowerCase()
      const abstract = (paper.abstract || '').toLowerCase()
      const content = `${title} ${abstract}`

      const keywordMap: Record<string, string[]> = {
        '机器学习': ['machine learning', 'ml', 'deep learning', 'neural network', '人工智能'],
        '网络安全': ['security', 'cybersecurity', 'network security', '加密', 'authentication'],
        '数据库': ['database', 'sql', 'nosql', '数据管理', 'data management'],
        '分布式系统': ['distributed', 'cloud', '集群', 'cluster', '微服务'],
        '图像处理': ['image', 'vision', '视觉', '图像', 'video'],
        '自然语言处理': ['nlp', 'natural language', '文本', 'text', '语言模型'],
      }

      let matchedCategory = null
      for (const [categoryName, keywords] of Object.entries(keywordMap)) {
        for (const keyword of keywords) {
          if (content.includes(keyword)) {
            matchedCategory = categories.find(c =>
              c.name.toLowerCase().includes(categoryName.toLowerCase())
            )
            if (matchedCategory) break
          }
        }
        if (matchedCategory) break
      }

      if (matchedCategory) {
        await prisma.paper.update({
          where: { id: paperId },
          data: { categoryId: matchedCategory.id }
        })

        return {
          success: true,
          message: `论文已自动分类到 "${matchedCategory.name}"`,
          data: { category: matchedCategory }
        }
      }

      return {
        success: false,
        message: '无法自动分类，请手动选择分类'
      }
    } catch (err) {
      return {
        success: false,
        message: `自动分类失败: ${(err as Error).message}`
      }
    }
  }
}

export const agentService = new AgentService()
