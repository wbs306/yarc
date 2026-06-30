import { Hono } from 'hono'
import { searchCategoryService } from '../services/search-category.service.js'
import { rankingService } from '../services/ranking.service.js'

const searchCategories = new Hono()

const withRankings = async <T extends { journal?: string | null; venue?: string | null }>(papers: T[]) => Promise.all(
  papers.map(async (paper) => {
    const name = paper.journal || paper.venue || ''
    return {
      ...paper,
      rankings: name ? await rankingService.getRankingsWithCustom(name) : { ccf: null, sci: null },
    }
  })
)

// GET /api/search-categories - 获取所有分类
searchCategories.get('/', async (c) => {
  try {
    const categories = searchCategoryService.getCategoryTree()
    return c.json({ categories })
  } catch (err) {
    return c.json({ error: { code: 'FETCH_ERROR', message: (err as Error).message } }, 500)
  }
})

// GET /api/search-categories/flat - 获取所有分类（平铺）
searchCategories.get('/flat', async (c) => {
  try {
    const categories = searchCategoryService.getCategories()
    return c.json({ categories })
  } catch (err) {
    return c.json({ error: { code: 'FETCH_ERROR', message: (err as Error).message } }, 500)
  }
})

// POST /api/search-categories/move-paper - 移动论文到另一个分类
searchCategories.post('/move-paper', async (c) => {
  try {
    const body = await c.req.json()
    const { fromCategoryId, toCategoryId, paperId } = body

    if (!fromCategoryId || !toCategoryId || !paperId) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少必要参数' } }, 400)
    }

    searchCategoryService.movePaper(fromCategoryId, toCategoryId, paperId)
    return c.json({ success: true })
  } catch (err) {
    return c.json({ error: { code: 'MOVE_ERROR', message: (err as Error).message } }, 500)
  }
})

// GET /api/search-categories/search?q=xxx - 搜索论文
searchCategories.get('/search', async (c) => {
  const query = c.req.query('q')
  if (!query) {
    return c.json({ error: { code: 'MISSING_QUERY', message: '搜索关键词不能为空' } }, 400)
  }

  try {
    const results = searchCategoryService.searchPapers(query)
    return c.json({ results })
  } catch (err) {
    return c.json({ error: { code: 'SEARCH_ERROR', message: (err as Error).message } }, 500)
  }
})

// GET /api/search-categories/:id - 获取单个分类
searchCategories.get('/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const category = searchCategoryService.getCategory(id)
    if (!category) {
      return c.json({ error: { code: 'NOT_FOUND', message: '分类不存在' } }, 404)
    }
    return c.json({ category })
  } catch (err) {
    return c.json({ error: { code: 'FETCH_ERROR', message: (err as Error).message } }, 500)
  }
})

// POST /api/search-categories - 创建分类
searchCategories.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { name, parentId } = body

    if (!name) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '分类名称不能为空' } }, 400)
    }

    const category = searchCategoryService.createCategory(name, parentId)
    return c.json({ category }, 201)
  } catch (err) {
    return c.json({ error: { code: 'CREATE_ERROR', message: (err as Error).message } }, 500)
  }
})

// PUT /api/search-categories/:id - 更新分类
searchCategories.put('/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const body = await c.req.json()
    const { name, parentId } = body

    const category = searchCategoryService.updateCategory(id, { name, parentId })
    return c.json({ category })
  } catch (err) {
    return c.json({ error: { code: 'UPDATE_ERROR', message: (err as Error).message } }, 500)
  }
})

// DELETE /api/search-categories/:id - 删除分类
searchCategories.delete('/:id', async (c) => {
  const id = c.req.param('id')
  try {
    searchCategoryService.deleteCategory(id)
    return c.json({ success: true })
  } catch (err) {
    return c.json({ error: { code: 'DELETE_ERROR', message: (err as Error).message } }, 500)
  }
})

// GET /api/search-categories/:id/papers - 获取分类中的论文
searchCategories.get('/:id/papers', async (c) => {
  const id = c.req.param('id')
  try {
    const papers = await withRankings(searchCategoryService.getPapers(id))
    return c.json({ papers })
  } catch (err) {
    return c.json({ error: { code: 'FETCH_ERROR', message: (err as Error).message } }, 500)
  }
})

// POST /api/search-categories/:id/papers - 添加论文到分类
searchCategories.post('/:id/papers', async (c) => {
  const id = c.req.param('id')
  try {
    const body = await c.req.json()
    const { paper, papers } = body

    if (papers && Array.isArray(papers)) {
      // 批量添加
      const savedPapers = searchCategoryService.addPapers(id, papers)
      return c.json({ papers: savedPapers }, 201)
    } else if (paper) {
      // 单个添加
      const savedPaper = searchCategoryService.addPaper(id, paper)
      return c.json({ paper: savedPaper }, 201)
    } else {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '请提供论文数据' } }, 400)
    }
  } catch (err) {
    return c.json({ error: { code: 'ADD_ERROR', message: (err as Error).message } }, 500)
  }
})

// DELETE /api/search-categories/:categoryId/papers/:paperId - 从分类中删除论文
searchCategories.delete('/:categoryId/papers/:paperId', async (c) => {
  const categoryId = c.req.param('categoryId')
  const paperId = c.req.param('paperId')
  try {
    searchCategoryService.removePaper(categoryId, paperId)
    return c.json({ success: true })
  } catch (err) {
    return c.json({ error: { code: 'DELETE_ERROR', message: (err as Error).message } }, 500)
  }
})

export default searchCategories
